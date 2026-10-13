import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, decide, defineQuestions } from "../src/index.js";
import type { JSONSchema } from "../src/index.js";
import {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_TOOL_NAME,
  anthropicProvider,
} from "../src/providers/anthropic.js";

// A distinctive fake key: it must never show up in any error message or result.
const FAKE_KEY = "sk-ant-test-FAKE-KEY-do-not-leak-7f3a9c";

const schema: JSONSchema = {
  type: "object",
  properties: { urgent: { type: "object", properties: { value: { type: "boolean" } } } },
  required: ["urgent"],
  additionalProperties: false,
};

interface Captured {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockFetch(...responses: (Response | Error)[]) {
  const calls: Captured[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error("mockFetch: no response scripted");
    if (next instanceof Error) throw next;
    return next;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function toolReply(input: unknown): Response {
  return jsonResponse({
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_1", name: ANTHROPIC_TOOL_NAME, input }],
    stop_reason: "tool_use",
  });
}

async function catchError(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
  throw new Error("expected the promise to reject");
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("DECIDEKIT_MODEL", "");
  // Guard: any accidental use of the global fetch fails the test.
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

describe("anthropicProvider: configuration", () => {
  it("implements Provider with the default model", () => {
    const provider = anthropicProvider({ apiKey: FAKE_KEY });
    expect(provider.name).toBe("anthropic");
    expect(provider.model).toBe(ANTHROPIC_DEFAULT_MODEL);
    expect(provider.model).toBe("claude-haiku-4-5");
    expect(typeof provider.complete).toBe("function");
  });

  it("uses DECIDEKIT_MODEL when set, and the option over the env", () => {
    vi.stubEnv("DECIDEKIT_MODEL", "claude-sonnet-4-5");
    expect(anthropicProvider({ apiKey: FAKE_KEY }).model).toBe("claude-sonnet-4-5");
    expect(anthropicProvider({ apiKey: FAKE_KEY, model: "claude-opus-4-1" }).model).toBe("claude-opus-4-1");
  });

  it("reads the key from ANTHROPIC_API_KEY", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", FAKE_KEY);
    const { fn, calls } = mockFetch(toolReply({}));
    await anthropicProvider({ fetch: fn }).complete({ prompt: "p", schema });
    expect((calls[0]?.init.headers as Record<string, string>)["x-api-key"]).toBe(FAKE_KEY);
  });

  it("throws at construction naming ANTHROPIC_API_KEY when no key is set", () => {
    expect(() => anthropicProvider()).toThrow(ProviderError);
    expect(() => anthropicProvider()).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => anthropicProvider({ apiKey: "  " })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("rejects a bad maxTokens", () => {
    expect(() => anthropicProvider({ apiKey: FAKE_KEY, maxTokens: 0 })).toThrow(/maxTokens/);
  });

  it("does not expose the key on the provider object", () => {
    const provider = anthropicProvider({ apiKey: FAKE_KEY });
    expect(JSON.stringify(provider)).not.toContain(FAKE_KEY);
    expect(Object.values(provider).map(String).join(" ")).not.toContain(FAKE_KEY);
  });
});

describe("anthropicProvider: request contract", () => {
  it("POSTs to /v1/messages with the right headers and body", async () => {
    const { fn, calls } = mockFetch(toolReply({ urgent: { value: true } }));
    const provider = anthropicProvider({ apiKey: FAKE_KEY, fetch: fn });
    const controller = new AbortController();

    const result = await provider.complete({ prompt: "Hello prompt", schema, signal: controller.signal });

    expect(result).toEqual({ json: { urgent: { value: true } } });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.init.method).toBe("POST");
    expect(call.init.signal).toBe(controller.signal);
    expect(call.init.headers).toEqual({
      "x-api-key": FAKE_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(call.init.body))).toEqual({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello prompt" }],
      tools: [{ name: "record_decisions", description: expect.any(String), input_schema: schema }],
      tool_choice: { type: "tool", name: "record_decisions" },
    });
  });

  it("honours baseUrl (trailing slash trimmed), model and maxTokens", async () => {
    const { fn, calls } = mockFetch(toolReply({}));
    const provider = anthropicProvider({
      apiKey: FAKE_KEY,
      baseUrl: "http://localhost:9999/",
      model: "claude-x",
      maxTokens: 50,
      fetch: fn,
    });
    await provider.complete({ prompt: "p", schema });
    expect(calls[0]?.url).toBe("http://localhost:9999/v1/messages");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("claude-x");
    expect(body.max_tokens).toBe(50);
  });

  it("uses the global fetch when no fetch option is given", async () => {
    const { fn, calls } = mockFetch(toolReply({ a: 1 }));
    vi.stubGlobal("fetch", fn);
    const result = await anthropicProvider({ apiKey: FAKE_KEY }).complete({ prompt: "p", schema });
    expect(result).toEqual({ json: { a: 1 } });
    expect(calls).toHaveLength(1);
  });

  it("falls back to { text } when there is no tool_use block", async () => {
    const { fn } = mockFetch(
      jsonResponse({ content: [{ type: "text", text: '{"urgent":' }, { type: "text", text: "true}" }] }),
    );
    const result = await anthropicProvider({ apiKey: FAKE_KEY, fetch: fn }).complete({ prompt: "p", schema });
    expect(result).toEqual({ text: '{"urgent":true}' });
  });
});

describe("anthropicProvider: errors", () => {
  it.each([
    [401, "authentication_error", "invalid x-api-key"],
    [429, "rate_limit_error", "Number of requests has exceeded your rate limit"],
    [500, "api_error", "Internal server error"],
    [529, "overloaded_error", "Overloaded"],
    [400, "invalid_request_error", "max_tokens: too large"],
  ])("HTTP %i gives a readable ProviderError with the status", async (status, type, message) => {
    const { fn } = mockFetch(jsonResponse({ type: "error", error: { type, message } }, status));
    const error = await catchError(anthropicProvider({ apiKey: FAKE_KEY, fetch: fn }).complete({ prompt: "p", schema }));
    expect(error.status).toBe(status);
    expect(error.provider).toBe("anthropic");
    expect(error.message).toContain(`HTTP ${status}`);
    expect(error.message).toContain(message);
  });

  it("handles a non-JSON error body", async () => {
    const { fn } = mockFetch(new Response("Bad Gateway", { status: 502 }));
    const error = await catchError(anthropicProvider({ apiKey: FAKE_KEY, fetch: fn }).complete({ prompt: "p", schema }));
    expect(error.status).toBe(502);
    expect(error.message).toMatch(/HTTP 502.*Bad Gateway/);
  });

  it("wraps a network failure with a sanitised copy of the cause", async () => {
    const cause = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    const { fn } = mockFetch(cause);
    const error = await catchError(anthropicProvider({ apiKey: FAKE_KEY, fetch: fn }).complete({ prompt: "p", schema }));
    expect(error.provider).toBe("anthropic");
    expect(error.status).toBeUndefined();
    expect(error.message).toContain("fetch failed");
    // A copy, never the original (which could contain the key).
    expect(error.cause).not.toBe(cause);
    const copy = error.cause as Error & { cause?: Error & { code?: string } };
    expect(copy).toBeInstanceOf(Error);
    expect(copy.name).toBe("TypeError");
    expect(copy.message).toBe("fetch failed");
    expect(copy.cause?.message).toBe("connect ECONNREFUSED");
    expect(copy.cause?.code).toBe("ECONNREFUSED");
  });

  it("lets an abort propagate unchanged", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = new DOMException("aborted", "AbortError");
    const { fn } = mockFetch(abortError);
    await expect(
      anthropicProvider({ apiKey: FAKE_KEY, fetch: fn }).complete({ prompt: "p", schema, signal: controller.signal }),
    ).rejects.toBe(abortError);
  });

  it("rethrows the signal's own reason unchanged", async () => {
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    controller.abort(reason);
    const { fn } = mockFetch(reason);
    await expect(
      anthropicProvider({ apiKey: FAKE_KEY, fetch: fn }).complete({ prompt: "p", schema, signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  it("sanitises a non-abort fetch error even when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const leaky = new Error(`socket closed for x-api-key=${FAKE_KEY}`);
    const { fn } = mockFetch(leaky);
    const error = await catchError(
      anthropicProvider({ apiKey: FAKE_KEY, fetch: fn }).complete({ prompt: "p", schema, signal: controller.signal }),
    );
    expect(error).not.toBe(leaky);
    expect(error.cause).not.toBe(leaky);
    expect(inspect(error, { depth: 10 })).not.toContain(FAKE_KEY);
    expect(error.message).toContain("[REDACTED]");
  });

  it("sanitises a non-abort body-read error even when the signal is aborted", async () => {
    const controller = new AbortController();
    const leaky = new Error(`stream broke, key ${FAKE_KEY}`);
    const res = jsonResponse({});
    vi.spyOn(res, "text").mockImplementation(async () => {
      controller.abort();
      throw leaky;
    });
    const { fn } = mockFetch(res);
    const error = await catchError(
      anthropicProvider({ apiKey: FAKE_KEY, fetch: fn }).complete({ prompt: "p", schema, signal: controller.signal }),
    );
    expect(error.message).toMatch(/could not read the response body/);
    expect(error.cause).not.toBe(leaky);
    expect(inspect(error, { depth: 10 })).not.toContain(FAKE_KEY);
  });

  it("rethrows an AbortError from the body reader unchanged", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("aborted", "AbortError");
    const res = jsonResponse({});
    vi.spyOn(res, "text").mockImplementation(async () => {
      controller.abort();
      throw abortError;
    });
    const { fn } = mockFetch(res);
    await expect(
      anthropicProvider({ apiKey: FAKE_KEY, fetch: fn }).complete({ prompt: "p", schema, signal: controller.signal }),
    ).rejects.toBe(abortError);
  });

  it("rejects a malformed envelope", async () => {
    const { fn } = mockFetch(new Response("not json", { status: 200 }), jsonResponse({ id: "x" }));
    const provider = anthropicProvider({ apiKey: FAKE_KEY, fetch: fn });
    expect((await catchError(provider.complete({ prompt: "p", schema }))).message).toMatch(/not valid JSON/);
    expect((await catchError(provider.complete({ prompt: "p", schema }))).message).toMatch(/content/);
  });
});

describe("anthropicProvider: the API key never leaks", () => {
  it("is absent from errors even when the body echoes the headers", async () => {
    const echo = { type: "error", error: { type: "authentication_error", message: `bad key: x-api-key=${FAKE_KEY}` } };
    const { fn } = mockFetch(
      jsonResponse(echo, 401),
      new Response(`raw echo ${FAKE_KEY} ${FAKE_KEY}`, { status: 500 }),
      new Error(`connect failed with header ${FAKE_KEY}`),
    );
    const logs = vi.spyOn(console, "log");
    const errs = vi.spyOn(console, "error");
    const warns = vi.spyOn(console, "warn");
    const provider = anthropicProvider({ apiKey: FAKE_KEY, fetch: fn });

    for (let i = 0; i < 3; i++) {
      const error = await catchError(provider.complete({ prompt: "p", schema }));
      expect(error.message).not.toContain(FAKE_KEY);
      expect(String(error)).not.toContain(FAKE_KEY);
      expect(error.stack ?? "").not.toContain(FAKE_KEY);
    }
    for (const spy of [logs, errs, warns]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(FAKE_KEY);
    }
  });

  it("is absent from the missing-key error and from decide() results and errors", async () => {
    expect(() => anthropicProvider()).toThrow(expect.objectContaining({ message: expect.not.stringContaining(FAKE_KEY) }));

    const questions = defineQuestions({ urgent: { type: "boolean", instructions: "Urgent?" } });
    const ok = mockFetch(toolReply({ urgent: { value: true, confidence: 0.8 } }));
    const result = await decide({
      provider: anthropicProvider({ apiKey: FAKE_KEY, fetch: ok.fn }),
      input: "help",
      questions,
    });
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);

    const bad = mockFetch(jsonResponse({ error: { message: `echo ${FAKE_KEY}` } }, 401));
    const error = await catchError(
      decide({ provider: anthropicProvider({ apiKey: FAKE_KEY, fetch: bad.fn }), input: "help", questions }),
    );
    expect(error.message).not.toContain(FAKE_KEY);
    expect(error.status).toBe(401);
  });
});

describe("decide() end to end with anthropicProvider (mocked fetch)", () => {
  const questions = defineQuestions({
    urgent: { type: "boolean", instructions: "Does this need a reply today?" },
    team: { type: "choice", instructions: "Which team?", options: ["Billing", "Technical"] },
    frustration: { type: "score", instructions: "How frustrated?", min: 1, max: 5, integer: true },
  });

  it("sends the schema as the tool input_schema and returns validated answers", async () => {
    const { fn, calls } = mockFetch(
      toolReply({
        urgent: { value: true, confidence: 0.9 },
        team: { value: "Billing", scores: { Billing: 0.8, Technical: 0.2 } },
        frustration: { value: 4 },
      }),
    );
    const result = await decide({
      provider: anthropicProvider({ apiKey: FAKE_KEY, fetch: fn }),
      input: "I was charged twice.",
      questions,
    });

    expect(result.answers.urgent).toEqual({ ok: true, value: true, confidence: 0.9 });
    expect(result.answers.team).toMatchObject({ ok: true, value: "Billing" });
    expect(result.answers.frustration).toEqual({ ok: true, value: 4 });
    expect(result.meta).toMatchObject({ provider: "anthropic", model: "claude-haiku-4-5", attempts: 1 });

    const body = JSON.parse(String(calls[0]?.init.body)) as {
      messages: { content: string }[];
      tools: { input_schema: { properties: Record<string, unknown> } }[];
    };
    expect(body.messages[0]?.content).toContain("I was charged twice.");
    expect(Object.keys(body.tools[0]!.input_schema.properties).sort()).toEqual(["frustration", "team", "urgent"]);
  });

  it("retries an invalid answer with a second API call", async () => {
    const { fn, calls } = mockFetch(
      toolReply({
        urgent: { value: "yes", confidence: 0.9 },
        team: { value: "Technical", scores: { Billing: 0.1, Technical: 0.9 } },
        frustration: { value: 2 },
      }),
      toolReply({ urgent: { value: false, confidence: 0.6 } }),
    );
    const result = await decide({
      provider: anthropicProvider({ apiKey: FAKE_KEY, fetch: fn }),
      input: "Just a question about the API.",
      questions,
    });
    expect(calls).toHaveLength(2);
    expect(result.meta.attempts).toBe(2);
    expect(result.answers.urgent).toEqual({ ok: true, value: false, confidence: 0.6 });
  });
});

describe("anthropicProvider key never leaks through error causes", () => {
  /** Message, stack and own properties of every error in the cause chain, plus inspect output. */
  function everything(error: unknown): string {
    const parts: string[] = [inspect(error, { depth: 20, showHidden: true })];
    let current: unknown = error;
    for (let depth = 0; current instanceof Error && depth < 20; depth++) {
      parts.push(current.message, current.stack ?? "", JSON.stringify({ ...current }));
      current = current.cause;
    }
    return parts.join("\n");
  }

  it("sanitises the whole cause chain on a network error", async () => {
    const inner = Object.assign(new Error(`socket closed for key ${FAKE_KEY}`), { code: `E_${FAKE_KEY}` });
    const outer = new TypeError(`Headers.append: "${FAKE_KEY}" is an invalid header value.`, { cause: inner });
    const { fn } = mockFetch(outer);
    const error = await catchError(anthropicProvider({ apiKey: FAKE_KEY, fetch: fn }).complete({ prompt: "p", schema }));
    expect(error.message).toContain("[REDACTED]");
    expect(everything(error)).not.toContain(FAKE_KEY);
    const copy = error.cause as Error & { cause?: Error & { code?: string } };
    expect(copy.message).toBe('Headers.append: "[REDACTED]" is an invalid header value.');
    expect(copy.cause?.message).toBe("socket closed for key [REDACTED]");
    expect(copy.cause?.code).toBe("E_[REDACTED]");
  });

  it("sanitises the cause when reading the response body fails", async () => {
    const res = new Response("ok", { status: 200 });
    vi.spyOn(res, "text").mockRejectedValue(new Error(`stream broke near ${FAKE_KEY}`, { cause: new Error(FAKE_KEY) }));
    const { fn } = mockFetch(res);
    const error = await catchError(anthropicProvider({ apiKey: FAKE_KEY, fetch: fn }).complete({ prompt: "p", schema }));
    expect(error.message).toMatch(/could not read the response body \(HTTP 200\)/);
    expect(error.status).toBe(200);
    expect((error.cause as Error).message).toBe("stream broke near [REDACTED]");
    expect(everything(error)).not.toContain(FAKE_KEY);
  });

  it("util.inspect of the error never shows the key", async () => {
    const { fn } = mockFetch(new TypeError(`bad header ${FAKE_KEY}`));
    const error = await catchError(anthropicProvider({ apiKey: FAKE_KEY, fetch: fn }).complete({ prompt: "p", schema }));
    expect(inspect(error, { depth: 20, showHidden: true })).not.toContain(FAKE_KEY);
    expect(inspect(error)).toContain("[REDACTED]");
  });

  it("redacts escaped and stripped variants of the key", async () => {
    const { fn } = mockFetch(
      new Error(`a ${JSON.stringify(FAKE_KEY)} b ${encodeURIComponent(FAKE_KEY)} c ${FAKE_KEY}`),
    );
    const error = await catchError(anthropicProvider({ apiKey: FAKE_KEY, fetch: fn }).complete({ prompt: "p", schema }));
    expect(everything(error)).not.toContain(FAKE_KEY);
  });

  it.each([
    ["a newline", "sk-ant-x\ny"],
    ["a trailing newline", "sk-ant-xy\n"],
    ["a carriage return", "sk-ant-x\ry"],
    ["a space", "sk-ant-x y"],
    ["a tab", "sk-ant-x\ty"],
    ["a NUL byte", "sk-ant-x\u0000y"],
  ])("rejects a key containing %s at construction without echoing it", (_label, badKey) => {
    let caught: unknown;
    try {
      anthropicProvider({ apiKey: badKey, fetch: mockFetch().fn });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    const message = (caught as Error).message;
    expect(message).toMatch(/ANTHROPIC_API_KEY contains invalid characters/);
    expect(message).toMatch(/newline/);
    expect(everything(caught)).not.toContain("sk-ant-x");
  });

  it("rejects an invalid key coming from the environment too", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env\nkey");
    expect(() => anthropicProvider({ fetch: mockFetch().fn })).toThrow(/ANTHROPIC_API_KEY contains invalid characters/);
  });
});
