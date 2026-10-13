/**
 * The provider interface: the only thing decide() needs from an LLM backend.
 */

/**
 * A JSON Schema document (draft 2020-12 subset). decide() builds these from
 * the questions using only widely supported keywords: `type`, `properties`,
 * `required`, `additionalProperties`, `enum`, `minimum`, `maximum` and
 * `description`.
 */
export interface JSONSchema {
  readonly type?: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JSONSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JSONSchema;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly items?: JSONSchema;
}

/** What decide() sends to a provider on each attempt. */
export interface ProviderRequest {
  /**
   * The complete prompt: instructions, the questions, and the input text
   * wrapped in delimiters. Send it as the user message.
   */
  readonly prompt: string;
  /**
   * A JSON Schema the response object must match. Providers should use it to
   * constrain the output where the API supports it, for example as a tool's
   * `input_schema` (Anthropic tool use) or as `format` (Ollama structured
   * output). It describes only the questions asked in this attempt, so a
   * retry gets a smaller schema.
   */
  readonly schema: JSONSchema;
  /** Abort signal from the caller. Pass it to `fetch`. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * A provider's reply. Return `{ text }` with the raw model text (decide()
 * extracts the JSON object, tolerating code fences or a sentence around it),
 * or `{ json }` when the API already returned parsed JSON (for example a
 * tool-use block's `input`). decide() validates either form.
 */
export type ProviderResponse = { readonly text: string } | { readonly json: unknown };

/**
 * An LLM backend. Implementations call the model with plain `fetch`.
 *
 * Contract:
 * - `complete()` makes exactly one model call per invocation. decide() calls
 *   it once per attempt (at most twice per decision).
 * - Transport and HTTP failures (network errors, non-2xx status, malformed
 *   API envelopes) must be thrown as `ProviderError` (with `status` for HTTP
 *   failures). decide() does not retry these.
 * - A model reply that is not valid JSON or does not match the schema is NOT
 *   a transport failure: return it as `{ text }` or `{ json }` and let
 *   decide() validate it and retry.
 * - Never put API keys or other secrets in errors or logs.
 *
 * @example
 * ```ts
 * const provider: Provider = {
 *   name: "echo",
 *   model: "fake-1",
 *   async complete({ prompt, schema, signal }) {
 *     const res = await fetch(url, { method: "POST", body: JSON.stringify({ prompt, schema }), signal });
 *     if (!res.ok) throw new ProviderError(`echo: HTTP ${res.status}`, { provider: "echo", status: res.status });
 *     return { text: await res.text() };
 *   },
 * };
 * ```
 */
export interface Provider {
  /** Short provider name, reported in `meta.provider` (for example `"anthropic"`). */
  readonly name: string;
  /** Model identifier, reported in `meta.model`. */
  readonly model: string;
  /** Sends one prompt and returns the model's reply. */
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}
