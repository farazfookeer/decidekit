/**
 * Errors thrown by decide() and by providers.
 */

/**
 * Thrown when the input passed to decide() is unusable: empty or
 * whitespace-only text, text longer than `maxInputChars`, or a bad
 * `maxInputChars` value. decide() never truncates input.
 */
export class DecideInputError extends Error {
  override readonly name = "DecideInputError";
}

/** Options for {@link ProviderError}. */
export interface ProviderErrorOptions {
  /** The provider's name (for example `"anthropic"` or `"ollama"`). */
  readonly provider?: string | undefined;
  /** The HTTP status code, when the failure was an HTTP response. */
  readonly status?: number | undefined;
  /** The underlying error, if any. */
  readonly cause?: unknown;
}

/**
 * Base class for transport and HTTP failures inside a provider (network
 * errors, timeouts, non-2xx responses, malformed API envelopes).
 *
 * Providers should throw this (or a subclass) rather than a plain `Error`.
 * decide() lets it propagate unchanged: these failures never use the
 * answer-validation retry. If a provider throws anything else, decide() wraps
 * it in a `ProviderError` with the original as `cause` (except aborts, which
 * propagate as they are).
 *
 * Messages must never contain API keys or other secrets.
 */
export class ProviderError extends Error {
  override readonly name: string = "ProviderError";
  /** The provider's name, if known. */
  readonly provider: string | undefined;
  /** The HTTP status code, if the failure was an HTTP response. */
  readonly status: number | undefined;

  constructor(message: string, options: ProviderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.provider = options.provider;
    this.status = options.status;
  }
}
