import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, buildSchema, decide, defineQuestions, ollamaProvider } from "../src/index.js";
import type { JSONSchema } from "../src/index.js";
import { normalizeOllamaBaseUrl } from "../src/providers/ollama.js";

const SCHEMA: JSONSchema = {
  type: "object",
  properties: { urgent: { type: "boolean" } },
  required: ["urgent"],
  additionalProperties: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function chatResponse(content: string): Response {
  return jsonResponse({ model: "llama3.2", message: { role: "assistant", content }, done: true });
}

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

function mockFetch(...responses: (Response | Error)[]) {
  const queue = [...responses];
  return vi.fn(async (..._args: FetchArgs): Promise<Response> => {
    const next = queue.shift();
    if (next === undefined) throw new Error("mock fetch: no response scripted");
    if (next instanceof Error) throw next;
    return next;
  });
}

function sentBody(fetchMock: ReturnType<typeof mockFetch>, call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]?.[1];
  expect(typeof init?.body).toBe("string");
  return JSON.parse(init?.body as string) as Record<string, unknown>;
}

beforeEach(() => {
  vi.stubEnv("OLLAMA_HOST", "");
  // Any accidental use of the real network fails loudly.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("real fetch must not be called in tests");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("ollamaProvider: construction", () => {
  it("implements the Provider interface", () => {
    const provider = ollamaProvider({ model: "llama3.2" });
    expect(provider.name).toBe("ollama");
    expect(provider.model).toBe("llama3.2");
    expect(typeof provider.complete).toBe("function");
  });

  it("requires a model", () => {
    expect(() => ollamaProvider({ model: "" })).toThrow(/"model" is required/);
    expect(() => ollamaProvider({ model: "   " })).toThrow(/"model" is required/);
    // @ts-expect-error: model is missing on purpose
    expect(() => ollamaProvider({})).toThrow(/"model" is required/);
  });
});

describe("ollamaProvider: request shape", () => {
  it("POSTs to /api/chat with model, user message, stream false, format = schema and temperature 0", async () => {
    const fetchMock = mockFetch(chatResponse('{"urgent":{"value":true}}'));
    const provider = ollamaProvider({ model: "llama3.2", fetch: fetchMock });

    const result = await provider.complete({ prompt: "Is this urgent?", schema: SCHEMA });

    expect(result).toEqual({ text: '{"urgent":{"value":true}}' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:11434/api/chat");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(sentBody(fetchMock)).toEqual({
      model: "llama3.2",
      messages: [{ role: "user", content: "Is this urgent?" }],
      stream: false,
      format: SCHEMA,
      options: { temperature: 0 },
    });
  });

  it("merges extra options over temperature 0", async () => {
    const fetchMock = mockFetch(chatResponse("{}"), chatResponse("{}"));
    await ollamaProvider({ model: "m", fetch: fetchMock, options: { num_ctx: 8192 } }).complete({
      prompt: "p",
      schema: SCHEMA,
    });
    await ollamaProvider({ model: "m", fetch: fetchMock, options: { temperature: 0.7 } }).complete({
      prompt: "p",
      schema: SCHEMA,
    });
    expect(sentBody(fetchMock, 0)["options"]).toEqual({ temperature: 0, num_ctx: 8192 });
    expect(sentBody(fetchMock, 1)["options"]).toEqual({ temperature: 0.7 });
  });

  it("passes the abort signal to fetch", async () => {
    const fetchMock = mockFetch(chatResponse("{}"));
    const controller = new AbortController();
    await ollamaProvider({ model: "m", fetch: fetchMock }).complete({
      prompt: "p",
      schema: SCHEMA,
      signal: controller.signal,
    });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("uses the global fetch when none is given", async () => {
    const fetchMock = mockFetch(chatResponse("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await ollamaProvider({ model: "m" }).complete({ prompt: "p", schema: SCHEMA });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("ollamaProvider: base URL", () => {
  it("uses baseUrl, stripping a trailing slash", async () => {
    const fetchMock = mockFetch(chatResponse("{}"));
    await ollamaProvider({ model: "m", baseUrl: "http://gpu-box:8080/", fetch: fetchMock }).complete({
      prompt: "p",
      schema: SCHEMA,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://gpu-box:8080/api/chat");
  });

  it("honours OLLAMA_HOST when baseUrl is not given", async () => {
    vi.stubEnv("OLLAMA_HOST", "127.0.0.1:9999");
    const fetchMock = mockFetch(chatResponse("{}"));
    await ollamaProvider({ model: "m", fetch: fetchMock }).complete({ prompt: "p", schema: SCHEMA });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:9999/api/chat");
  });

  it("prefers baseUrl over OLLAMA_HOST", async () => {
    vi.stubEnv("OLLAMA_HOST", "http://from-env:1234");
    const fetchMock = mockFetch(chatResponse("{}"));
    await ollamaProvider({ model: "m", baseUrl: "http://explicit:5678", fetch: fetchMock }).complete({
      prompt: "p",
      schema: SCHEMA,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://explicit:5678/api/chat");
  });

  it("normalizes OLLAMA_HOST-style values", () => {
    expect(normalizeOllamaBaseUrl("0.0.0.0")).toBe("http://0.0.0.0:11434");
    expect(normalizeOllamaBaseUrl("example.com:8000")).toBe("http://example.com:8000");
    expect(normalizeOllamaBaseUrl("https://ollama.example.com/")).toBe("https://ollama.example.com");
    expect(normalizeOllamaBaseUrl(" http://localhost:11434 ")).toBe("http://localhost:11434");
  });
});

describe("ollamaProvider: base URL hardening", () => {
  it("brackets a bare IPv6 OLLAMA_HOST", async () => {
    expect(normalizeOllamaBaseUrl("::1")).toBe("http://[::1]:11434");
    expect(normalizeOllamaBaseUrl("fe80::1/ollama")).toBe("http://[fe80::1]:11434/ollama");
    expect(normalizeOllamaBaseUrl("[::1]:9999")).toBe("http://[::1]:9999");
    vi.stubEnv("OLLAMA_HOST", "::1");
    const fetchMock = mockFetch(chatResponse("{}"));
    await ollamaProvider({ model: "m", fetch: fetchMock }).complete({ prompt: "p", schema: SCHEMA });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://[::1]:11434/api/chat");
  });

  it("rejects a base URL with a username or password at creation, without echoing it", () => {
    for (const baseUrl of ["http://qauser:qasecret@127.0.0.1:9", "http://qasecret@127.0.0.1:9", "qauser:qasecret@127.0.0.1"]) {
      let error: unknown;
      try {
        ollamaProvider({ model: "m", baseUrl, fetch: mockFetch() });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("ollamaProvider: base URL must not contain a username or password");
      expect((error as Error).message).not.toContain("qasecret");
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("rejects credentials in OLLAMA_HOST too", () => {
    vi.stubEnv("OLLAMA_HOST", "http://u:envsecret@localhost:11434");
    expect(() => ollamaProvider({ model: "m", fetch: mockFetch() })).toThrow(/must not contain a username or password/);
  });

  it("rejects an unparseable or non-http base URL at creation with 'invalid Ollama base URL'", () => {
    expect(() => ollamaProvider({ model: "m", baseUrl: "http://::1", fetch: mockFetch() })).toThrow(
      /invalid Ollama base URL/,
    );
    expect(() => ollamaProvider({ model: "m", baseUrl: "http://bad host:1", fetch: mockFetch() })).toThrow(
      /invalid Ollama base URL/,
    );
    expect(() => ollamaProvider({ model: "m", baseUrl: "ftp://localhost:11434", fetch: mockFetch() })).toThrow(
      /invalid Ollama base URL.*http or https/,
    );
  });

  it("does not echo credentials when an unparseable URL is reported", () => {
    let error: unknown;
    try {
      ollamaProvider({ model: "m", baseUrl: "http://u:topsecret@bad host:1", fetch: mockFetch() });
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toMatch(/invalid Ollama base URL/);
    expect((error as Error).message).not.toContain("topsecret");
  });

  it("reports an invalid-URL TypeError from fetch as an invalid URL, not as unreachable", async () => {
    const fetchMock = mockFetch(new TypeError("Invalid URL"));
    const error = await ollamaProvider({ model: "m", fetch: fetchMock })
      .complete({ prompt: "p", schema: SCHEMA })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toMatch(/invalid Ollama base URL/);
    expect((error as Error).message).not.toMatch(/isn't reachable/);
    expect((error as Error).cause).toBeUndefined();
  });
});

describe("ollamaProvider: errors", () => {
  it("says Ollama isn't reachable and suggests `ollama serve` when fetch rejects", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" }),
    });
    const fetchMock = mockFetch(refused);
    const error = await ollamaProvider({ model: "m", fetch: fetchMock })
      .complete({ prompt: "p", schema: SCHEMA })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.message).toContain("isn't reachable at http://localhost:11434");
    expect(providerError.message).toContain("ollama serve");
    expect(providerError.provider).toBe("ollama");
    expect(providerError.status).toBeUndefined();
    expect(providerError.cause).toBe(refused);
  });

  it("reports status and Ollama's error text, and suggests `ollama pull` for a missing model", async () => {
    const fetchMock = mockFetch(jsonResponse({ error: "model 'llama9' not found" }, 404));
    const error = await ollamaProvider({ model: "llama9", fetch: fetchMock })
      .complete({ prompt: "p", schema: SCHEMA })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.status).toBe(404);
    expect(providerError.message).toContain("HTTP 404");
    expect(providerError.message).toContain("model 'llama9' not found");
    expect(providerError.message).toContain("ollama pull llama9");
  });

  it("reports other non-2xx responses with status and body text", async () => {
    const fetchMock = mockFetch(new Response("internal failure", { status: 500 }));
    const error = await ollamaProvider({ model: "m", fetch: fetchMock })
      .complete({ prompt: "p", schema: SCHEMA })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(500);
    expect((error as ProviderError).message).toContain("internal failure");
    expect((error as ProviderError).message).not.toContain("ollama pull");
  });

  it("throws ProviderError for a malformed envelope", async () => {
    const fetchMock = mockFetch(jsonResponse({ done: true }), new Response("not json", { status: 200 }));
    const provider = ollamaProvider({ model: "m", fetch: fetchMock });
    await expect(provider.complete({ prompt: "p", schema: SCHEMA })).rejects.toThrow(/message\.content/);
    await expect(provider.complete({ prompt: "p", schema: SCHEMA })).rejects.toThrow(/not valid JSON/);
  });

  it("lets aborts propagate unchanged", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = new DOMException("This operation was aborted", "AbortError");
    const fetchMock = mockFetch(abortError);
    const error = await ollamaProvider({ model: "m", fetch: fetchMock })
      .complete({ prompt: "p", schema: SCHEMA, signal: controller.signal })
      .catch((e: unknown) => e);
    expect(error).toBe(abortError);
  });
});

describe("decide() with ollamaProvider (mocked fetch)", () => {
  const questions = defineQuestions({
    urgent: { type: "boolean", instructions: "Does this need a reply today?" },
    team: { type: "choice", instructions: "Which team should handle it?", options: ["Billing", "Technical"] },
  });

  it("returns validated answers and sends the question schema as format", async () => {
    const content = JSON.stringify({
      urgent: { value: true, confidence: 0.8 },
      team: { value: "Billing", scores: { Billing: 0.9, Technical: 0.1 } },
    });
    const fetchMock = mockFetch(chatResponse(content));
    vi.stubGlobal("fetch", fetchMock);

    const result = await decide({
      provider: ollamaProvider({ model: "llama3.2" }),
      input: "I was charged twice this month.",
      questions,
    });

    expect(result.answers.urgent).toMatchObject({ value: true });
    expect(result.answers.team).toMatchObject({ value: "Billing" });
    expect(result.meta).toMatchObject({ provider: "ollama", model: "llama3.2", attempts: 1 });

    const body = sentBody(fetchMock);
    expect(body["format"]).toEqual(buildSchema(questions, ["urgent", "team"]));
    expect(body["stream"]).toBe(false);
    const messages = body["messages"] as { role: string; content: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toContain("I was charged twice this month.");
  });

  it("propagates the unreachable-server ProviderError without retrying", async () => {
    const fetchMock = mockFetch(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      decide({ provider: ollamaProvider({ model: "llama3.2" }), input: "Hello", questions }),
    ).rejects.toThrow(/ollama serve/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
