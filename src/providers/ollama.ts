/**
 * Ollama (local model) provider. Calls Ollama's `/api/chat` endpoint with
 * plain `fetch` and passes decide()'s JSON Schema as Ollama's `format`
 * parameter (structured output).
 */
import { ProviderError } from "../errors.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../provider.js";

/** Default Ollama server address. */
export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";

/** Options for {@link ollamaProvider}. */
export interface OllamaProviderOptions {
  /** The Ollama model to use, for example `"llama3.2"`. Required. */
  readonly model: string;
  /**
   * The Ollama server address. Defaults to the `OLLAMA_HOST` environment
   * variable if set, otherwise `http://localhost:11434`.
   */
  readonly baseUrl?: string | undefined;
  /** A `fetch` implementation. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch | undefined;
  /**
   * Extra Ollama model options (for example `{ num_ctx: 8192 }`). Merged over
   * the default `{ temperature: 0 }`.
   */
  readonly options?: Readonly<Record<string, unknown>> | undefined;
}

const NAME = "ollama";

/**
 * Turns a base URL or an `OLLAMA_HOST` value into an absolute URL without a
 * trailing slash. `OLLAMA_HOST` is often given without a scheme (for example
 * `127.0.0.1:11434` or `0.0.0.0`); such values get `http://` and, if they
 * have no port, Ollama's default port 11434. A bare IPv6 address (for example
 * `::1`) is bracketed, giving `http://[::1]:11434`.
 */
export function normalizeOllamaBaseUrl(value: string): string {
  let url = value.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const slashIndex = url.indexOf("/");
    let hostPart = slashIndex === -1 ? url : url.slice(0, slashIndex);
    const rest = slashIndex === -1 ? "" : url.slice(slashIndex);
    // Two or more colons without brackets can only be a bare IPv6 address.
    if (!hostPart.startsWith("[") && (hostPart.match(/:/g) ?? []).length >= 2) {
      hostPart = `[${hostPart}]`;
    }
    const hasPort = hostPart.startsWith("[") ? /\]:\d+$/.test(hostPart) : /:\d+$/.test(hostPart);
    url = `http://${hostPart}${hasPort ? "" : ":11434"}${rest}`;
  }
  return url.replace(/\/+$/, "");
}

/**
 * Removes any `user:password@` part from a URL-like string so it is safe to
 * show in a message. Works on strings that `new URL()` cannot parse too.
 */
function stripCredentials(value: string): string {
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1");
}

/**
 * Checks a normalised base URL at creation time: it must parse, use http or
 * https, and carry no username or password (Node's fetch refuses such URLs,
 * and echoing them would leak the secret).
 */
function validateBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`ollamaProvider: invalid Ollama base URL "${stripCredentials(baseUrl)}"`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("ollamaProvider: base URL must not contain a username or password");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`ollamaProvider: invalid Ollama base URL "${stripCredentials(baseUrl)}" (must be http or https)`);
  }
}

function resolveBaseUrl(baseUrl: string | undefined): string {
  let resolved = OLLAMA_DEFAULT_BASE_URL;
  if (baseUrl !== undefined && baseUrl.trim() !== "") {
    resolved = normalizeOllamaBaseUrl(baseUrl);
  } else {
    const env = process.env["OLLAMA_HOST"];
    if (env !== undefined && env.trim() !== "") resolved = normalizeOllamaBaseUrl(env);
  }
  validateBaseUrl(resolved);
  return resolved;
}

/** True for the TypeError fetch throws when it cannot parse the URL. */
function isInvalidUrlError(error: unknown): boolean {
  return error instanceof TypeError && /invalid url|failed to parse url/i.test(error.message);
}

/** Reads Ollama's error text from a failed response, if any. */
async function readErrorText(response: Response): Promise<string> {
  let body: string;
  try {
    body = await response.text();
  } catch {
    return "";
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    // Not JSON: fall through and use the raw text.
  }
  return body.trim().slice(0, 500);
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

/**
 * Creates a {@link Provider} backed by a local Ollama server.
 *
 * @example
 * ```ts
 * const provider = ollamaProvider({ model: "llama3.2" });
 * const result = await decide({ provider, input, questions });
 * ```
 */
export function ollamaProvider(options: OllamaProviderOptions): Provider {
  if (typeof options?.model !== "string" || options.model.trim() === "") {
    throw new Error('ollamaProvider: "model" is required (for example { model: "llama3.2" })');
  }
  const model = options.model;
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const url = `${baseUrl}/api/chat`;
  // Defence in depth: credentials are rejected above, but never show them.
  const shownBaseUrl = stripCredentials(baseUrl);
  const shownUrl = stripCredentials(url);
  const extraOptions = options.options ?? {};
  const fetchImpl = options.fetch;

  return {
    name: NAME,
    model,
    async complete({ prompt, schema, signal }: ProviderRequest): Promise<ProviderResponse> {
      const doFetch = fetchImpl ?? globalThis.fetch;
      const body = {
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        format: schema,
        options: { temperature: 0, ...extraOptions },
      };

      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        if (isInvalidUrlError(error)) {
          // No raw cause: fetch's message may quote the URL.
          throw new ProviderError(`ollama: invalid Ollama base URL "${shownBaseUrl}"`, { provider: NAME });
        }
        throw new ProviderError(
          `ollama: Ollama isn't reachable at ${shownBaseUrl}. Is it running? Start it with \`ollama serve\`.`,
          { provider: NAME, cause: error },
        );
      }

      if (!response.ok) {
        const errorText = await readErrorText(response);
        let message = `ollama: HTTP ${response.status} from ${shownUrl}`;
        if (errorText !== "") message += `: ${errorText}`;
        if (response.status === 404 || /not found/i.test(errorText)) {
          message += `. If the model isn't installed, run \`ollama pull ${model}\`.`;
        }
        throw new ProviderError(message, { provider: NAME, status: response.status });
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        throw new ProviderError(`ollama: response from ${shownUrl} was not valid JSON`, { provider: NAME, cause: error });
      }

      const content =
        typeof data === "object" &&
        data !== null &&
        "message" in data &&
        typeof data.message === "object" &&
        data.message !== null &&
        "content" in data.message
          ? data.message.content
          : undefined;
      if (typeof content !== "string") {
        throw new ProviderError(`ollama: response from ${shownUrl} has no message.content string`, { provider: NAME });
      }
      return { text: content };
    },
  };
}
