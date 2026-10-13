/**
 * Anthropic (Claude) provider: calls the Messages API with plain `fetch` and
 * uses tool use for native structured output.
 */
import { ProviderError } from "../errors.js";
import type { JSONSchema, Provider, ProviderRequest, ProviderResponse } from "../provider.js";

/** Default model when neither the `model` option nor `DECIDEKIT_MODEL` is set. */
export const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5";
/** Default API base URL. */
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
/** The `anthropic-version` header sent with every request. */
export const ANTHROPIC_API_VERSION = "2023-06-01";
/** Default `max_tokens` for each call. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 1024;
/** Name of the single tool the model is forced to call. */
export const ANTHROPIC_TOOL_NAME = "record_decisions";

/** Options for {@link anthropicProvider}. */
export interface AnthropicProviderOptions {
  /** Model id. Defaults to `DECIDEKIT_MODEL`, then `claude-haiku-4-5`. */
  readonly model?: string | undefined;
  /** API key. Defaults to the `ANTHROPIC_API_KEY` environment variable. */
  readonly apiKey?: string | undefined;
  /** API base URL. Defaults to `https://api.anthropic.com`. */
  readonly baseUrl?: string | undefined;
  /** `max_tokens` for each call. Defaults to 1024. */
  readonly maxTokens?: number | undefined;
  /** A `fetch` implementation. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch | undefined;
}

const PROVIDER = "anthropic";

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/** Matches whitespace and control characters, which a real API key never contains. */
const INVALID_KEY_CHARS = /[\s\u0000-\u001f\u007f-\u009f]/u;

/**
 * The forms in which the key could appear in someone else's error text: as
 * is, JSON-escaped, URL-encoded, and with whitespace or control characters
 * stripped (for example when a library renders a stray newline differently).
 * Longest first, so a longer variant is replaced before a shorter one inside it.
 */
function keyVariants(apiKey: string): string[] {
  const stripped = apiKey.replace(new RegExp(INVALID_KEY_CHARS.source, "gu"), "");
  const variants = new Set([apiKey, JSON.stringify(apiKey).slice(1, -1), encodeURIComponent(apiKey), stripped]);
  return [...variants].filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
}

/** Replaces every occurrence of the key (in any of its variants) so it can never leak into a message. */
function redact(text: string, apiKey: string): string {
  let result = text;
  for (const variant of keyVariants(apiKey)) result = result.split(variant).join("[REDACTED]");
  return result;
}

/**
 * Returns a sanitised copy of an error from fetch or the body reader, safe to
 * attach as a `cause`: the message (and any string `code`) are redacted, the
 * name is kept, and nested causes are sanitised the same way. The original
 * error is never attached, because its message, stack or other properties
 * might contain the key.
 */
function sanitiseError(error: unknown, apiKey: string, depth = 0): Error {
  const source = error instanceof Error ? error : undefined;
  const message = redact(source === undefined ? String(error) : String(source.message), apiKey);
  const nested = source?.cause;
  const cause = nested !== undefined && depth < 5 ? sanitiseError(nested, apiKey, depth + 1) : undefined;
  const copy = new Error(message, cause === undefined ? undefined : { cause });
  if (source !== undefined) copy.name = redact(String(source.name), apiKey);
  copy.stack = `${copy.name}: ${message}`;
  const code: unknown = source === undefined ? undefined : (source as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") {
    Object.defineProperty(copy, "code", { value: typeof code === "string" ? redact(code, apiKey) : code, enumerable: true });
  }
  return copy;
}

/**
 * True only for a genuine abort: the signal's own reason, or an error named
 * `AbortError`. Such errors carry no response data, so they are rethrown
 * unchanged. Any other error is sanitised before it leaves the provider.
 */
function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true && error === signal.reason) return true;
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pulls `error.message` out of an Anthropic error envelope, if present. */
function apiErrorMessage(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
  } catch {
    // Not JSON: fall through to the raw text below.
  }
  const trimmed = body.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, 300);
}

function statusHint(status: number): string {
  if (status === 401) return " (check that ANTHROPIC_API_KEY is valid)";
  if (status === 429) return " (rate limited; try again later)";
  if (status >= 500) return " (Anthropic server error; try again later)";
  return "";
}

/**
 * Creates a Provider backed by the Anthropic Messages API.
 *
 * The API key comes from `options.apiKey`, else `ANTHROPIC_API_KEY`. If
 * neither is set, this function throws a `ProviderError` immediately (at
 * construction, not on the first call). `.env` files are never loaded.
 *
 * Each call forces the model to call one tool (`record_decisions`) whose
 * `input_schema` is the request's JSON Schema, and returns the tool input as
 * `{ json }`. If the reply has no tool call, the text blocks are returned as
 * `{ text }` for decide() to parse and validate.
 *
 * The key is held privately and is never included in error messages, in the
 * `cause` of a thrown error (causes are sanitised copies), or in any property
 * of the returned provider. A key containing whitespace or control characters
 * (for example a stray newline) is rejected at construction.
 *
 * @example
 * ```ts
 * const provider = anthropicProvider({ model: "claude-haiku-4-5" });
 * const result = await decide({ provider, input, questions });
 * ```
 */
export function anthropicProvider(options: AnthropicProviderOptions = {}): Provider {
  const maybeKey = nonEmpty(options.apiKey) ?? nonEmpty(process.env.ANTHROPIC_API_KEY);
  if (maybeKey === undefined) {
    throw new ProviderError(
      "anthropic: no API key; set the ANTHROPIC_API_KEY environment variable or pass the apiKey option",
      { provider: PROVIDER },
    );
  }
  if (INVALID_KEY_CHARS.test(maybeKey)) {
    // Never echo the key itself here.
    throw new ProviderError(
      "anthropic: ANTHROPIC_API_KEY contains invalid characters (e.g. a stray newline or space); check the value you set",
      { provider: PROVIDER },
    );
  }
  const apiKey: string = maybeKey;
  const model = nonEmpty(options.model) ?? nonEmpty(process.env.DECIDEKIT_MODEL) ?? ANTHROPIC_DEFAULT_MODEL;
  const baseUrl = (nonEmpty(options.baseUrl) ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const maxTokens = options.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new ProviderError(`anthropic: "maxTokens" must be a positive whole number, got ${String(maxTokens)}`, {
      provider: PROVIDER,
    });
  }
  const fetchImpl = options.fetch;
  const url = `${baseUrl}/v1/messages`;

  async function complete({ prompt, schema, signal }: ProviderRequest): Promise<ProviderResponse> {
    const body = {
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
      tools: [
        {
          name: ANTHROPIC_TOOL_NAME,
          description: "Record the answer to every question.",
          input_schema: schema satisfies JSONSchema,
        },
      ],
      tool_choice: { type: "tool", name: ANTHROPIC_TOOL_NAME },
    };

    let res: Response;
    try {
      res = await (fetchImpl ?? fetch)(url, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_API_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      // Let aborts propagate unchanged, as decide() expects. Anything else is
      // sanitised, even if the signal happens to be aborted by now.
      if (isAbortError(error, signal)) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new ProviderError(redact(`anthropic: request to ${url} failed: ${reason}`, apiKey), {
        provider: PROVIDER,
        cause: sanitiseError(error, apiKey),
      });
    }

    let raw: string;
    try {
      raw = await res.text();
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      throw new ProviderError(`anthropic: could not read the response body (HTTP ${res.status})`, {
        provider: PROVIDER,
        status: res.status,
        cause: sanitiseError(error, apiKey),
      });
    }

    if (!res.ok) {
      const detail = apiErrorMessage(raw);
      const message = `anthropic: HTTP ${res.status}${statusHint(res.status)}${detail === undefined ? "" : `: ${detail}`}`;
      throw new ProviderError(redact(message, apiKey), { provider: PROVIDER, status: res.status });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ProviderError(`anthropic: response is not valid JSON (HTTP ${res.status})`, {
        provider: PROVIDER,
        status: res.status,
      });
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.content)) {
      throw new ProviderError(`anthropic: response has no "content" array (HTTP ${res.status})`, {
        provider: PROVIDER,
        status: res.status,
      });
    }

    const blocks = parsed.content.filter(isRecord);
    const toolUse = blocks.find((b) => b.type === "tool_use" && b.name === ANTHROPIC_TOOL_NAME);
    if (toolUse !== undefined) return { json: toolUse.input };
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    return { text };
  }

  return { name: PROVIDER, model, complete };
}
