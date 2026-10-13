/**
 * A scripted fake Provider for tests. No network access.
 *
 * Each call to `complete()` consumes the next scripted step:
 * - a `ProviderResponse` (`{ text }` or `{ json }`) is returned as is;
 * - a plain object without `text`/`json` is shorthand for `{ json: value }`;
 * - a string is shorthand for `{ text: value }`;
 * - an `Error` is thrown;
 * - a function receives the request and returns any of the above.
 *
 * Every request is recorded in `calls`. Running out of steps throws.
 */
import type { Provider, ProviderRequest, ProviderResponse } from "../../src/index.js";

export type FakeStep =
  | ProviderResponse
  | string
  | Error
  | Record<string, unknown>
  | ((request: ProviderRequest) => ProviderResponse | string | Error | Record<string, unknown>);

export interface FakeProvider extends Provider {
  /** Every request received, in order. */
  readonly calls: ProviderRequest[];
  /** Steps not yet consumed. */
  readonly remaining: () => number;
}

function toResponse(step: Exclude<FakeStep, (request: ProviderRequest) => unknown>): ProviderResponse {
  if (step instanceof Error) throw step;
  if (typeof step === "string") return { text: step };
  if ("text" in step && typeof step.text === "string" && Object.keys(step).length === 1) return { text: step.text };
  if ("json" in step && Object.keys(step).length === 1) return { json: step.json };
  return { json: step };
}

export function createFakeProvider(
  steps: readonly FakeStep[],
  options: { name?: string; model?: string } = {},
): FakeProvider {
  const queue = [...steps];
  const calls: ProviderRequest[] = [];
  return {
    name: options.name ?? "fake",
    model: options.model ?? "fake-model",
    calls,
    remaining: () => queue.length,
    async complete(request) {
      calls.push(request);
      const step = queue.shift();
      if (step === undefined) throw new Error(`fake provider: no scripted response for call ${calls.length}`);
      return toResponse(typeof step === "function" ? step(request) : step);
    },
  };
}
