// QA (R-3) integration tests for the Anthropic provider, written by qa-1.
// No real network calls: global fetch is stubbed to throw, and every test
// passes its own mocked fetch.
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, decide, defineQuestions } from "../src/index.js";
import type { JSONSchema } from "../src/index.js";
import { ANTHROPIC_TOOL_NAME, anthropicProvider } from "../src/providers/anthropic.js";

const KEY = "sk-ant-qa-FAKE-1234567890-zzz";
const ENV_KEY = "sk-ant-qa-ENV-KEY-0987654321";

const questions = defineQuestions({
  urgent: { type: "boolean", instructions: "Does this need a reply today?" },
  team: { type: "choice", instructions: "Which team?", options: ["Billing", "Technical"] },
  severity: { type: "score", instructions: "How severe, 1 to 5?", min: 1, max: 5, integer: true },
});

interface Call {
  url: string;
  init: RequestInit;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function scripted(...responses: (Response | Error | (() => Response))[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error("no response scripted");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const goodInput = {
  urgent: { value: true, confidence: 0.9 },
  team: { value: "Billing", scores: { Billing: 0.8, Technical: 0.2 } },
  severity: { value: 4 },
};

function toolReply(input: unknown): Response {
  return json({
    id: "msg_qa",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [
      { type: "text", text: "Recording." },
      { type: "tool_use", id: "toolu_qa", name: ANTHROPIC_TOOL_NAME, input },
    ],
    stop_reason: "tool_use",
  });
}

/** Every string reachable from an error: message, stack, cause chain, own props, inspect output. */
function everythingIn(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 10; depth++) {
    if (current instanceof Error) {
      parts.push(current.message, current.stack ?? "", JSON.stringify({ ...current }));
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  parts.push(inspect(error, { depth: 10 }));
  return parts.join("\n");
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("DECIDEKIT_MODEL", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("real network access is not allowed in tests");
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("QA R-3 criterion 1: Provider interface and model selection", () => {
  it("defaults to claude-haiku-4-5 and sends it in the body", async () => {
    const m = scripted(toolReply(goodInput));
    const p = anthropicProvider({ apiKey: KEY, fetch: m.fetch });
    expect(p.name).toBe("anthropic");
    expect(p.model).toBe("claude-haiku-4-5");
    expect(typeof p.complete).toBe("function");
    const result = await decide({ provider: p, input: "Charged twice, refund me today.", questions });
    expect(result.meta.model).toBe("claude-haiku-4-5");
    expect(result.meta.provider).toBe("anthropic");
    const body = JSON.parse(String(m.calls[0]?.init.body)) as { model: string };
    expect(body.model).toBe("claude-haiku-4-5");
  });

  it("DECIDEKIT_MODEL overrides the default; the option overrides DECIDEKIT_MODEL", async () => {
    vi.stubEnv("DECIDEKIT_MODEL", "claude-sonnet-4-5");
    expect(anthropicProvider({ apiKey: KEY }).model).toBe("claude-sonnet-4-5");
    const m = scripted(toolReply(goodInput));
    const p = anthropicProvider({ apiKey: KEY, model: "claude-opus-4-1", fetch: m.fetch });
    expect(p.model).toBe("claude-opus-4-1");
    await decide({ provider: p, input: "x", questions });
    expect((JSON.parse(String(m.calls[0]?.init.body)) as { model: string }).model).toBe("claude-opus-4-1");
  });

  it("an empty or whitespace model option falls back", () => {
    vi.stubEnv("DECIDEKIT_MODEL", "  ");
    expect(anthropicProvider({ apiKey: KEY, model: "" }).model).toBe("claude-haiku-4-5");
  });

  it("end to end through decide(): validated answers from tool_use input", async () => {
    const m = scripted(toolReply(goodInput));
    const result = await decide({ provider: anthropicProvider({ apiKey: KEY, fetch: m.fetch }), input: "x", questions });
    expect(result.answers.urgent).toMatchObject({ ok: true, value: true });
    expect(result.answers.team).toMatchObject({ ok: true, value: "Billing" });
    expect(result.answers.severity).toMatchObject({ ok: true, value: 4 });
    expect(m.calls).toHaveLength(1);
  });

  it("text-only reply is handed to decide() for parsing", async () => {
    const m = scripted(json({ content: [{ type: "text", text: "```json\n" + JSON.stringify(goodInput) + "\n```" }] }));
    const result = await decide({ provider: anthropicProvider({ apiKey: KEY, fetch: m.fetch }), input: "x", questions });
    expect(result.answers.urgent).toMatchObject({ ok: true, value: true });
  });

  it("an invalid tool input triggers decide()'s retry with a smaller schema", async () => {
    const bad = { ...goodInput, severity: { value: 9 } };
    const m = scripted(toolReply(bad), toolReply({ severity: { value: 3 } }));
    const result = await decide({ provider: anthropicProvider({ apiKey: KEY, fetch: m.fetch }), input: "x", questions });
    expect(m.calls).toHaveLength(2);
    expect(result.answers.severity).toMatchObject({ ok: true, value: 3 });
    const retrySchema = (JSON.parse(String(m.calls[1]?.init.body)) as { tools: { input_schema: JSONSchema }[] })
      .tools[0]?.input_schema;
    expect(retrySchema?.type).toBe("object");
    expect(Object.keys(retrySchema?.properties ?? {})).toEqual(["severity"]);
  });
});

describe("QA R-3 criterion 2: missing key and HTTP errors", () => {
  it("missing key (unset, empty, whitespace) names ANTHROPIC_API_KEY", () => {
    for (const v of ["", "   "]) {
      vi.stubEnv("ANTHROPIC_API_KEY", v);
      expect(() => anthropicProvider()).toThrow(/ANTHROPIC_API_KEY/);
      expect(() => anthropicProvider({ apiKey: "  " })).toThrow(ProviderError);
    }
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => anthropicProvider()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it.each([
    [401, /HTTP 401/, /ANTHROPIC_API_KEY/],
    [429, /HTTP 429/, /rate limit/i],
    [500, /HTTP 500/, /server error/i],
    [503, /HTTP 503/, /server error/i],
    [529, /HTTP 529/, /server error/i],
  ])("HTTP %i gives a readable ProviderError through decide()", async (status, a, b) => {
    const m = scripted(json({ type: "error", error: { type: "x", message: "upstream said no" } }, status));
    const err = await rejection(decide({ provider: anthropicProvider({ apiKey: KEY, fetch: m.fetch }), input: "x", questions }));
    expect(err).toBeInstanceOf(ProviderError);
    const pe = err as ProviderError;
    expect(pe.status).toBe(status);
    expect(pe.provider).toBe("anthropic");
    expect(pe.message).toMatch(a);
    expect(pe.message).toMatch(b);
    expect(pe.message).toContain("upstream said no");
    expect(m.calls).toHaveLength(1); // never retried
  });

  it("HTTP 400 with an HTML body still names the status", async () => {
    const m = scripted(new Response("<html>bad gateway</html>", { status: 400 }));
    const err = (await rejection(anthropicProvider({ apiKey: KEY, fetch: m.fetch }).complete({ prompt: "p", schema: { type: "object" } }))) as ProviderError;
    expect(err.message).toMatch(/HTTP 400/);
    expect(err.status).toBe(400);
  });

  it("2xx with a malformed envelope is a ProviderError, not a crash", async () => {
    for (const r of [new Response("not json", { status: 200 }), json({ nope: true }), json({ content: "x" })]) {
      const m = scripted(r);
      const err = await rejection(anthropicProvider({ apiKey: KEY, fetch: m.fetch }).complete({ prompt: "p", schema: { type: "object" } }));
      expect(err).toBeInstanceOf(ProviderError);
    }
  });

  it("an aborted signal propagates as an abort, not wrapped", async () => {
    const ac = new AbortController();
    ac.abort();
    const abortErr = new DOMException("aborted", "AbortError");
    const m = scripted(abortErr);
    const err = await rejection(
      anthropicProvider({ apiKey: KEY, fetch: m.fetch }).complete({ prompt: "p", schema: { type: "object" }, signal: ac.signal }),
    );
    expect(err).toBe(abortErr);
  });
});

describe("QA R-3 criterion 3: the key never leaks", () => {
  it("key is absent from the provider object and from result meta", async () => {
    const m = scripted(toolReply(goodInput));
    const p = anthropicProvider({ apiKey: KEY, fetch: m.fetch });
    expect(JSON.stringify(p)).not.toContain(KEY);
    expect(inspect(p, { depth: 10, showHidden: true })).not.toContain(KEY);
    const result = await decide({ provider: p, input: "x", questions });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(inspect(result, { depth: 10 })).not.toContain(KEY);
  });

  it("key echoed in HTTP error bodies (all statuses) is redacted, including through decide()", async () => {
    for (const status of [400, 401, 403, 429, 500]) {
      const m = scripted(json({ error: { message: `invalid x-api-key: ${KEY} (${KEY})` } }, status));
      const err = await rejection(decide({ provider: anthropicProvider({ apiKey: KEY, fetch: m.fetch }), input: "x", questions }));
      expect(everythingIn(err)).not.toContain(KEY);
    }
    const m = scripted(new Response(`raw text with ${KEY}`, { status: 502 }));
    const err = await rejection(decide({ provider: anthropicProvider({ apiKey: KEY, fetch: m.fetch }), input: "x", questions }));
    expect(everythingIn(err)).not.toContain(KEY);
  });

  it("key from env is redacted too", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", ENV_KEY);
    const m = scripted(json({ error: { message: `bad key ${ENV_KEY}` } }, 401));
    const err = await rejection(anthropicProvider({ fetch: m.fetch }).complete({ prompt: "p", schema: { type: "object" } }));
    expect(everythingIn(err)).not.toContain(ENV_KEY);
  });

  it("a network error that contains the key does not leak it anywhere in the error (message or cause chain)", async () => {
    // e.g. undici: `Headers.append: "<key>" is an invalid header value.`
    const m = scripted(new TypeError(`Headers.append: "${KEY}" is an invalid header value.`));
    const err = await rejection(decide({ provider: anthropicProvider({ apiKey: KEY, fetch: m.fetch }), input: "x", questions }));
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).not.toContain(KEY);
    expect(everythingIn(err)).not.toContain(KEY);
  });

  it("no console output during success or failure", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    const m = scripted(toolReply(goodInput), json({ error: { message: KEY } }, 401));
    const p = anthropicProvider({ apiKey: KEY, fetch: m.fetch });
    await decide({ provider: p, input: "x", questions });
    await rejection(decide({ provider: p, input: "x", questions }));
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe("QA R-3 criterion 4: request contract", () => {
  it("URL, headers and Messages API tool-use body", async () => {
    const m = scripted(toolReply(goodInput));
    await decide({ provider: anthropicProvider({ apiKey: KEY, fetch: m.fetch }), input: "Charged twice.", questions });
    const call = m.calls[0];
    expect(call?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call?.init.method).toBe("POST");
    const headers = new Headers(call?.init.headers);
    expect(headers.get("x-api-key")).toBe(KEY);
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBeNull();

    const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "tool_choice", "tools"]);
    expect(body.max_tokens).toBe(1024);
    const messages = body.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toContain("Charged twice.");
    const tools = body.tools as { name: string; description: string; input_schema: JSONSchema }[];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe(ANTHROPIC_TOOL_NAME);
    expect(tools[0]?.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(typeof tools[0]?.description).toBe("string");
    expect(tools[0]?.description.length).toBeGreaterThan(0);
    expect(body.tool_choice).toEqual({ type: "tool", name: ANTHROPIC_TOOL_NAME });

    const s = tools[0]?.input_schema;
    expect(s?.type).toBe("object");
    expect(s?.required).toEqual(["urgent", "team", "severity"]);
    expect(Object.keys(s?.properties ?? {})).toEqual(["urgent", "team", "severity"]);
    expect(s?.properties?.team?.properties?.value?.enum).toEqual(["Billing", "Technical"]);
    expect(s?.properties?.severity?.properties?.value).toMatchObject({ type: "integer", minimum: 1, maximum: 5 });
  });

  it("custom baseUrl (trailing slashes trimmed) and maxTokens are honoured", async () => {
    const m = scripted(toolReply(goodInput));
    await anthropicProvider({ apiKey: KEY, fetch: m.fetch, baseUrl: "http://localhost:9999//", maxTokens: 50 }).complete({
      prompt: "p",
      schema: { type: "object" },
    });
    expect(m.calls[0]?.url).toBe("http://localhost:9999/v1/messages");
    expect((JSON.parse(String(m.calls[0]?.init.body)) as { max_tokens: number }).max_tokens).toBe(50);
  });

  it("rejects bad maxTokens at creation", () => {
    for (const n of [0, -1, 1.5, Number.NaN]) expect(() => anthropicProvider({ apiKey: KEY, maxTokens: n })).toThrow(ProviderError);
  });

  it("option key overrides env key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", ENV_KEY);
    const m = scripted(toolReply(goodInput), toolReply(goodInput));
    await anthropicProvider({ apiKey: KEY, fetch: m.fetch }).complete({ prompt: "p", schema: { type: "object" } });
    await anthropicProvider({ fetch: m.fetch }).complete({ prompt: "p", schema: { type: "object" } });
    expect(new Headers(m.calls[0]?.init.headers).get("x-api-key")).toBe(KEY);
    expect(new Headers(m.calls[1]?.init.headers).get("x-api-key")).toBe(ENV_KEY);
  });

  it("uses the global fetch when no fetch option is given (stubbed here)", async () => {
    const g = vi.fn(async () => toolReply(goodInput));
    vi.stubGlobal("fetch", g);
    await anthropicProvider({ apiKey: KEY }).complete({ prompt: "p", schema: { type: "object" } });
    expect(g).toHaveBeenCalledTimes(1);
  });

  it("passes the abort signal to fetch", async () => {
    const m = scripted(toolReply(goodInput));
    const ac = new AbortController();
    await anthropicProvider({ apiKey: KEY, fetch: m.fetch }).complete({ prompt: "p", schema: { type: "object" }, signal: ac.signal });
    expect(m.calls[0]?.init.signal).toBe(ac.signal);
  });
});

// ---------------------------------------------------------------------------
// Attempt 2 (qa-1): attacks on the sanitised-cause fix.
// ---------------------------------------------------------------------------
describe("QA R-3 criterion 3 (attempt 2): sanitised causes resist hostile errors", () => {
  const S = { type: "object" } as const;

  async function failWith(thrown: unknown, key = KEY): Promise<unknown> {
    const fetchImpl = (async () => {
      throw thrown;
    }) as unknown as typeof fetch;
    return rejection(decide({ provider: anthropicProvider({ apiKey: key, fetch: fetchImpl }), input: "x", questions }));
  }

  function assertClean(err: unknown, key = KEY): void {
    expect(err).toBeInstanceOf(ProviderError);
    const all = everythingIn(err) + inspect(err, { depth: 20, showHidden: true });
    expect(all).not.toContain(key);
    expect(all).not.toContain(JSON.stringify(key).slice(1, -1));
    expect(all).not.toContain(encodeURIComponent(key));
  }

  it("key in name, message, code, stack and a deep cause chain", async () => {
    const inner = new Error(`inner ${KEY}`);
    (inner as { code?: string }).code = `E_${KEY}`;
    const mid = new TypeError(`mid ${KEY}`, { cause: inner });
    mid.name = `Bad${KEY}`;
    mid.stack = `stack with ${KEY}`;
    const outer = new Error(`fetch failed for ${KEY}`, { cause: mid });
    const err = await failWith(outer);
    assertClean(err);
    // The chain is still useful (message kept, key redacted).
    expect(String(((err as Error).cause as Error).message)).toContain("[REDACTED]");
  });

  it("key in arbitrary extra properties (headers, request, config) is not copied", async () => {
    const e = new Error("fetch failed") as Error & Record<string, unknown>;
    e.headers = { "x-api-key": KEY };
    e.request = { init: { headers: [["x-api-key", KEY]] } };
    e.config = KEY;
    assertClean(await failWith(e));
  });

  it("AggregateError with nested errors containing the key", async () => {
    const agg = new AggregateError([new Error(`a ${KEY}`), new Error(`b`, { cause: KEY })], `connect failed ${KEY}`);
    const err = await failWith(new TypeError("fetch failed", { cause: agg }));
    assertClean(err);
  });

  it("thrown value / cause that is a string or plain object", async () => {
    assertClean(await failWith(`string thrown ${KEY}`));
    assertClean(await failWith({ message: KEY, apiKey: KEY }));
    assertClean(await failWith({ toString: () => `obj ${KEY}` }));
    assertClean(await failWith(new Error("x", { cause: `cause string ${KEY}` })));
    assertClean(await failWith(new Error("x", { cause: { key: KEY, nested: { k: KEY } } })));
    assertClean(await failWith(new Error("x", { cause: { toString: () => KEY } })));
  });

  it("unstringifiable thrown values (null-prototype object, symbol) still give a clean ProviderError", async () => {
    assertClean(await failWith(Object.create(null)));
    assertClean(await failWith(Symbol(KEY)));
  });

  it("cyclic cause chain terminates and is clean", async () => {
    const a = new Error(`a ${KEY}`);
    const b = new Error(`b ${KEY}`, { cause: a });
    (a as { cause?: unknown }).cause = b;
    assertClean(await failWith(a));
  });

  it("JSON-escaped and URL-encoded key forms are redacted", async () => {
    const odd = 'sk-ant-qa"quote\\back/slash%pct+plus&amp=eq';
    const variants = [odd, JSON.stringify(odd).slice(1, -1), encodeURIComponent(odd)];
    for (const v of variants) {
      assertClean(await failWith(new Error(`echo ${v}`, { cause: new Error(`c ${v}`) }), odd), odd);
    }
  });

  it("res.text() rejecting with the key is sanitised", async () => {
    const body = new ReadableStream({
      start(c) {
        c.error(new Error(`stream died ${KEY}`, { cause: new Error(KEY) }));
      },
    });
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const err = await rejection(anthropicProvider({ apiKey: KEY, fetch: fetchImpl }).complete({ prompt: "p", schema: S }));
    assertClean(err);
    expect((err as Error).message).toMatch(/could not read the response body/);
  });

  it("keys with whitespace/control characters are rejected at creation without echoing the key", () => {
    for (const bad of [`${KEY}\n`, ` ${KEY}`, `${KEY}\r`, `sk-ant\tx`, `sk-ant\u0000x`, `sk-ant\u007fx`, `sk-ant x`, `sk-ant x`, `sk-ant﻿x`]) {
      let caught: unknown;
      try {
        anthropicProvider({ apiKey: bad });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ProviderError);
      expect((caught as Error).message).toMatch(/ANTHROPIC_API_KEY/);
      expect(everythingIn(caught)).not.toContain(bad.trim());
      expect(everythingIn(caught)).not.toContain("sk-ant");
    }
  });

  it("unicode key that passes the check: refused connection (mocked ECONNREFUSED) fails without leaking it", async () => {
    for (const key of ["sk-ant-€uro-QA-SECRET-1", "sk-ant-ÿ-QA-SECRET-2", "sk-ant-​zw-QA-SECRET-3", "sk-ant-plain-QA-SECRET-4"]) {
      const refused = vi.fn(async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }),
        });
      }) as unknown as typeof fetch;
      const p = anthropicProvider({ apiKey: key, baseUrl: "http://127.0.0.1:9", fetch: refused });
      const err = await rejection(decide({ provider: p, input: "x", questions }));
      assertClean(err, key);
      expect(everythingIn(err)).not.toContain("QA-SECRET");
      expect((err as Error).message).toMatch(/request to http:\/\/127\.0\.0\.1:9\/v1\/messages failed/);
    }
  });

  // Real loopback probe: opt-in via DECIDEKIT_QA_LOOPBACK=1 so `npm test` stays network-free.
  it.skipIf(process.env["DECIDEKIT_QA_LOOPBACK"] !== "1")("unicode key that passes the check: real fetch (127.0.0.1:9 only) fails without leaking it", async () => {
    vi.unstubAllGlobals(); // use the real fetch, but only against a closed local port
    for (const key of ["sk-ant-€uro-QA-SECRET-1", "sk-ant-ÿ-QA-SECRET-2", "sk-ant-​zw-QA-SECRET-3", "sk-ant-plain-QA-SECRET-4"]) {
      const p = anthropicProvider({ apiKey: key, baseUrl: "http://127.0.0.1:9" });
      const err = await rejection(decide({ provider: p, input: "x", questions }));
      assertClean(err, key);
      expect(everythingIn(err)).not.toContain("QA-SECRET");
      expect((err as Error).message).toMatch(/request to http:\/\/127\.0\.0\.1:9\/v1\/messages failed/);
    }
  });

  it("result meta and provider object never contain the key (unicode key, success path)", async () => {
    const key = "sk-ant-€-meta-QA";
    const m = scripted(toolReply(goodInput));
    const p = anthropicProvider({ apiKey: key, fetch: m.fetch });
    const r = await decide({ provider: p, input: "x", questions });
    expect(JSON.stringify(r.meta)).not.toContain(key);
    expect(inspect(p, { depth: 10, showHidden: true })).not.toContain(key);
  });
});
