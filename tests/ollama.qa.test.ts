/**
 * QA (Ibn al-Haytham) for R-4: Ollama (local model) connector.
 *
 * Network policy: the only "real" fetch used here targets 127.0.0.1:9 (the
 * discard port on the loopback interface), which refuses the connection
 * locally. Everything else goes through a mocked fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, decide, defineQuestions, ollamaProvider } from "../src/index.js";
import type { JSONSchema, Provider } from "../src/index.js";
import { normalizeOllamaBaseUrl } from "../src/providers/ollama.js";

const realFetch = globalThis.fetch;
const REFUSED = "http://127.0.0.1:9";
// Real loopback probes are opt-in so `npm test` stays network-free (CLAUDE.md).
const LOOPBACK = process.env["DECIDEKIT_QA_LOOPBACK"] === "1";

/** Mimics what Node's fetch throws for a refused connection. */
function refusedFetch() {
  return vi.fn(async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }) });
  });
}

const SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    team: { type: "string", enum: ["Billing", "Technical"] },
    score: { type: "integer", minimum: 1, maximum: 5 },
  },
  required: ["team", "score"],
  additionalProperties: false,
};

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

function okFetch(content: string) {
  return vi.fn(async (..._args: FetchArgs): Promise<Response> =>
    new Response(JSON.stringify({ message: { role: "assistant", content }, done: true }), { status: 200 }),
  );
}

function sent(fetchMock: ReturnType<typeof okFetch>, call = 0) {
  const args = fetchMock.mock.calls[call];
  expect(args).toBeDefined();
  const init = args?.[1];
  return { url: String(args?.[0]), init, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
}

beforeEach(() => {
  vi.stubEnv("OLLAMA_HOST", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("QA: unexpected global fetch");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("QA R-4 criterion 1: Provider interface and schema passthrough", () => {
  it("satisfies the Provider type and sends the exact schema object as `format` (deep equal, not stringified)", async () => {
    const f = okFetch('{"team":"Billing","score":3}');
    const provider: Provider = ollamaProvider({ model: "qwen2.5:7b", baseUrl: "http://localhost:11434", fetch: f });
    const res = await provider.complete({ prompt: "PROMPT", schema: SCHEMA });
    expect(res).toEqual({ text: '{"team":"Billing","score":3}' });
    const { url, init, body } = sent(f);
    expect(url).toBe("http://localhost:11434/api/chat");
    expect(init?.method).toBe("POST");
    expect(body["format"]).toEqual(SCHEMA);
    expect(typeof body["format"]).toBe("object");
    expect(body["model"]).toBe("qwen2.5:7b");
    expect(body["stream"]).toBe(false);
    expect(body["messages"]).toEqual([{ role: "user", content: "PROMPT" }]);
  });

  it("end to end through decide(): a retry sends a smaller schema as format", async () => {
    const questions = defineQuestions({
      urgent: { type: "boolean", instructions: "Urgent?" },
      team: { type: "choice", instructions: "Team?", options: ["Billing", "Technical"] },
    });
    // First reply: urgent valid, team invalid -> decide() retries just `team`.
    const replies = ['{"urgent":{"value":true,"confidence":0.9},"team":{"value":"Nope","confidence":0.5}}'];
    const f = vi.fn(async (..._args: FetchArgs): Promise<Response> => {
      const content = replies.shift() ?? '{"team":{"value":"Billing","confidence":0.8}}';
      return new Response(JSON.stringify({ message: { content } }), { status: 200 });
    });
    const provider = ollamaProvider({ model: "m", fetch: f });
    await decide({ provider, input: "charged twice", questions });
    expect(f).toHaveBeenCalledTimes(2);
    const first = sent(f, 0).body["format"] as JSONSchema;
    const second = sent(f, 1).body["format"] as JSONSchema;
    expect(Object.keys(first.properties ?? {}).sort()).toEqual(["team", "urgent"]);
    expect(Object.keys(second.properties ?? {})).toEqual(["team"]);
  });

  it("passes the caller's AbortSignal object through to fetch and propagates a real abort", async () => {
    const controller = new AbortController();
    const f = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const provider = ollamaProvider({ model: "m", fetch: f as unknown as typeof fetch });
    const p = provider.complete({ prompt: "x", schema: SCHEMA, signal: controller.signal });
    expect(f.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    controller.abort();
    const err = await p.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ProviderError);
    expect((err as Error).name).toBe("AbortError");
  });

  it("rejects missing / blank model at creation", () => {
    expect(() => ollamaProvider({ model: "" })).toThrow(/model/);
    expect(() => ollamaProvider({ model: "   " })).toThrow(/model/);
    // @ts-expect-error deliberately missing options
    expect(() => ollamaProvider(undefined)).toThrow(/model/);
  });
});

describe("QA R-4 criterion 2: unreachable server (mocked ECONNREFUSED)", () => {
  it("ProviderError names the URL, says not reachable, suggests `ollama serve`, keeps cause", async () => {
    const provider = ollamaProvider({ model: "llama3.2", baseUrl: REFUSED, fetch: refusedFetch() });
    const err = await provider.complete({ prompt: "x", schema: SCHEMA }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toBe(
      "ollama: Ollama isn't reachable at http://127.0.0.1:9. Is it running? Start it with `ollama serve`.",
    );
    expect(((err as Error).cause as Error).message).toBe("fetch failed");
  });
});

describe.skipIf(!LOOPBACK)("QA R-4 criterion 2: unreachable server (opt-in real loopback fetch, connection refused)", () => {
  it("real fetch to a closed local port -> ProviderError naming the URL and suggesting `ollama serve`", async () => {
    const provider = ollamaProvider({ model: "llama3.2", baseUrl: REFUSED, fetch: realFetch });
    const err = await provider.complete({ prompt: "x", schema: SCHEMA }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    const pe = err as ProviderError;
    expect(pe.provider).toBe("ollama");
    expect(pe.message).toContain("isn't reachable");
    expect(pe.message).toContain(REFUSED);
    expect(pe.message).toContain("ollama serve");
    expect(pe.cause).toBeDefined();
  });

  it("same via OLLAMA_HOST without scheme, and through decide() (no retry)", async () => {
    vi.stubEnv("OLLAMA_HOST", "127.0.0.1:9");
    vi.stubGlobal("fetch", realFetch);
    const provider = ollamaProvider({ model: "llama3.2" });
    const questions = defineQuestions({ urgent: { type: "boolean", instructions: "Urgent?" } });
    const err = await decide({ provider, input: "hi", questions }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toMatch(/isn't reachable at http:\/\/127\.0\.0\.1:9\b.*ollama serve/);
  });
});

describe("QA R-4: OLLAMA_HOST normalisation", () => {
  it.each([
    ["localhost", "http://localhost:11434"],
    ["0.0.0.0", "http://0.0.0.0:11434"],
    ["127.0.0.1:11434", "http://127.0.0.1:11434"],
    ["  myhost:8080/  ", "http://myhost:8080"],
    ["myhost/ollama", "http://myhost:11434/ollama"],
    ["https://ollama.example.test", "https://ollama.example.test"],
    ["http://localhost:11434///", "http://localhost:11434"],
    ["[::1]", "http://[::1]:11434"],
    ["[::1]:9999", "http://[::1]:9999"],
  ])("%j -> %s", (input, expected) => {
    expect(normalizeOllamaBaseUrl(input)).toBe(expected);
  });

  it("whitespace-only baseUrl falls back to OLLAMA_HOST, then the default", async () => {
    vi.stubEnv("OLLAMA_HOST", "envhost:1234");
    const f = okFetch("{}");
    await ollamaProvider({ model: "m", baseUrl: "  ", fetch: f }).complete({ prompt: "p", schema: SCHEMA });
    expect(sent(f).url).toBe("http://envhost:1234/api/chat");
    vi.stubEnv("OLLAMA_HOST", "   ");
    const g = okFetch("{}");
    await ollamaProvider({ model: "m", fetch: g }).complete({ prompt: "p", schema: SCHEMA });
    expect(sent(g).url).toBe("http://localhost:11434/api/chat");
  });

  it("OLLAMA_HOST is read at creation time, not per call", async () => {
    vi.stubEnv("OLLAMA_HOST", "first:1");
    const f = okFetch("{}");
    const provider = ollamaProvider({ model: "m", fetch: f });
    vi.stubEnv("OLLAMA_HOST", "second:2");
    await provider.complete({ prompt: "p", schema: SCHEMA });
    expect(sent(f).url).toBe("http://first:1/api/chat");
  });
});

describe("QA R-4: failure paths", () => {
  it("HTTP 500 with plain-text body is reported with status and text, no `ollama pull` hint", async () => {
    const f = vi.fn(async () => new Response("boom", { status: 500 }));
    const err = await ollamaProvider({ model: "m", fetch: f })
      .complete({ prompt: "p", schema: SCHEMA })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(500);
    expect((err as Error).message).toContain("500");
    expect((err as Error).message).toContain("boom");
    expect((err as Error).message).not.toContain("ollama pull");
  });

  it("404 model-not-found suggests `ollama pull <model>`", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: 'model "llama9" not found, try pulling it first' }), { status: 404 }));
    const err = await ollamaProvider({ model: "llama9", fetch: f })
      .complete({ prompt: "p", schema: SCHEMA })
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain("ollama pull llama9");
    expect((err as ProviderError).status).toBe(404);
  });

  it("200 with non-JSON body or missing message.content -> ProviderError", async () => {
    for (const body of ["<html>", JSON.stringify({ done: true }), JSON.stringify({ message: { content: 42 } })]) {
      const f = vi.fn(async () => new Response(body, { status: 200 }));
      const err = await ollamaProvider({ model: "m", fetch: f })
        .complete({ prompt: "p", schema: SCHEMA })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
    }
  });

  it("empty content string is returned as text (decide() validates it, not a transport error)", async () => {
    const f = okFetch("");
    await expect(ollamaProvider({ model: "m", fetch: f }).complete({ prompt: "p", schema: SCHEMA })).resolves.toEqual({ text: "" });
  });
});

describe.skipIf(!LOOPBACK)("QA R-4 observation: credentials in base URL (opt-in loopback)", () => {
  // Observation probe, documents current behaviour. Ollama needs no key, but a
  // proxy URL may carry user:pass. Records whether the raw URL is echoed.
  it("records whether user:pass in baseUrl is echoed in the unreachable error", async () => {
    // Flipped after the R-4 hardening follow-up: credential URLs are now
    // rejected at creation, and the message does not echo the secret.
    let err: Error | undefined;
    try {
      await ollamaProvider({ model: "m", baseUrl: "http://qauser:qasecret@127.0.0.1:9", fetch: realFetch }).complete({ prompt: "p", schema: SCHEMA });
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toMatch(/must not contain a username or password/);
    expect(String(err?.message).includes("qasecret")).toBe(false);
  });
});

describe("QA R-4 criterion 3: no real network in the suite", () => {
  it("the default global fetch stub in this file throws, proving tests must inject fetch", async () => {
    const err = await ollamaProvider({ model: "m" })
      .complete({ prompt: "p", schema: SCHEMA })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(((err as Error).cause as Error).message).toBe("QA: unexpected global fetch");
  });
});
