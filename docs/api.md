# API reference

Everything below is exported from the package entry point:

```ts
import { decide, defineQuestions, anthropicProvider, ollamaProvider } from "decidekit";
```

- [`decide()`](#decide)
- [`defineQuestions()`](#definequestions)
- [Result types](#result-types)
- [Question sets](#question-sets)
- [Labelled examples and accuracy](#labelled-examples-and-accuracy)
- [Errors](#errors)
- [Providers](#providers): [`anthropicProvider`](#anthropicprovider), [`ollamaProvider`](#ollamaprovider), [the `Provider` interface](#the-provider-interface)
- [CLI](#cli)
- [Smoke scripts](#smoke-scripts)

## `decide()`

```ts
function decide<const Q extends Questions>(options: DecideOptions<Q>): Promise<DecideResult<Q>>;
```

Asks the provider every question about one text in **one** model call, then validates each answer against its type.

| Option          | Type                          | Meaning |
|-----------------|-------------------------------|---------|
| `provider`      | `Provider`                    | The LLM backend, for example `anthropicProvider()` or `ollamaProvider({ model })`. |
| `input`         | `string`                      | The text to analyse. Must not be empty or whitespace only. |
| `questions`     | questions map or `QuestionSet` | Inline questions (ideally via `defineQuestions`) or a set from `loadQuestionSet`. |
| `maxInputChars` | `number` (optional)           | Reject input longer than this many characters. Input is never truncated. |
| `signal`        | `AbortSignal` (optional)      | Cancels the provider call. |

Behaviour:

- If any answer is missing or invalid (or the reply isn't JSON), decide() retries **once**, re-asking only those questions and showing the model what was wrong. Answers still invalid after the retry come back as `{ ok: false, error }`. So a decision makes one or two provider calls (`meta.attempts`).
- Extra keys in the model's reply are ignored.
- Provider failures (`ProviderError`) propagate and are never retried. If a custom provider throws anything else, decide() wraps it in a `ProviderError` with the original as `cause`. Aborts propagate unchanged.
- Empty input, input over `maxInputChars`, or a bad `maxInputChars` throws `DecideInputError`.
- Invalid inline questions throw `QuestionSetError`.

## `defineQuestions()`

```ts
function defineQuestions<const Q extends Questions>(questions: Q): Q;
```

Returns its argument unchanged. It exists so TypeScript keeps the literal types of inline questions, which lets decide() infer exact answer types: a choice's `value` is the union of its options, and its `scores` has one key per option.

```ts
const questions = defineQuestions({
  urgent: { type: "boolean", instructions: "Does this need a reply today?" },
  team: { type: "choice", instructions: "Which team?", options: ["Billing", "Technical"] },
  stars: { type: "score", instructions: "Rate 1 to 5.", min: 1, max: 5, integer: true },
});
// result.answers.team.value is "Billing" | "Technical" (when ok)
```

Writing the questions inline in the `decide({ questions: { ... } })` call infers the same types.

## Result types

```ts
interface DecideResult<Q> {
  answers: { [K in keyof Q]: AnswerFor<Q[K]> };
  meta: DecideMeta;
}

interface DecideMeta {
  provider: string;   // provider.name
  model: string;      // provider.model
  latencyMs: number;  // wall-clock time across all attempts
  attempts: number;   // 1, or 2 when a retry was needed
}
```

Every answer is either valid (`ok: true`) or failed (`ok: false`). **Always check `ok`** before reading `value`.

| Question type | Valid answer | Notes |
|---------------|--------------|-------|
| `boolean` | `{ ok: true, value: boolean, confidence: number }` | `confidence` (0 to 1) is the model's own estimate that the answer is correct. |
| `choice`  | `{ ok: true, value: Option, scores: Record<Option, number> }` | `value` is exactly one of the options. `scores` has an estimate (0 to 1) for every option, normalised to sum to 1. |
| `score`   | `{ ok: true, value: number }` | Within `min`..`max` inclusive, and a whole number when `integer: true`. |
| any (failed) | `{ ok: false, error: string }` | Why the answer was still invalid after the retry. |

> **`confidence` and `scores` are uncalibrated.** They are the model's own estimates. In this first phase decidekit does nothing to calibrate them, so 0.9 does not mean "right 90% of the time". Measure real accuracy with [`measureAccuracy`](#labelled-examples-and-accuracy) or `decidekit test`.

Choice scores whose raw sum is between 0.9 and 1.1 (`SCORE_SUM_TOLERANCE`) are renormalised to sum to 1; outside that range the answer is invalid and retried.

Type helpers: `AnswerFor<Q>`, `ValidAnswerFor<Q>`, `AnswerValue<Q>`, `Answers<Q>`, `BooleanAnswer`, `ChoiceAnswer<O>`, `ScoreAnswer`, `FailedAnswer`, `OptionOf<Q>`, `DecideOptions<Q>`, `DecideResult<Q>`, `DecideMeta`, `Questions`.

With a question set loaded from YAML the answer types are general (a choice `value` is `string`), because the options are only known at run time.

## Question sets

See [the question set format](question-set-format.md) for the YAML format.

| Function | Meaning |
|----------|---------|
| `loadQuestionSet(path)` | Reads and validates a YAML file. Returns `Promise<QuestionSet>`. |
| `parseQuestionSet(text, label)` | Parses and validates YAML text already in memory. |
| `validateQuestionSet(obj, label)` | Validates a plain object (for example from JSON). |

Types: `QuestionSet`, `Question`, `BooleanQuestion`, `ChoiceQuestion`, `ScoreQuestion`, `QuestionType`, `QuestionBase`. Constants: `QUESTION_TYPES`, `QUESTION_KEY_PATTERN`.

## Labelled examples and accuracy

See [the labelled examples format](labelled-examples-format.md).

| Function | Meaning |
|----------|---------|
| `loadExamples(path, set)` | Reads and validates a `<set>.examples.yaml` file against a set. |
| `parseExamples(text, set, label)` / `validateExamples(obj, set, label)` | The same for text or an object already in memory. |
| `measureAccuracy({ provider, set, examples, tolerance?, maxInputChars?, signal? })` | Runs decide() on every example, one at a time, and returns an `AccuracyReport`. |
| `isCorrect(question, expected, answer, tolerance?)` | Scores one answer: booleans and choices must be equal; scores within `tolerance`. A failed answer is wrong. |

`AccuracyReport` has `set`, `provider`, `model`, `tolerance`, `examples` (count), `questions` (per-question `{ correct, total, accuracy }`), `overall`, and `wrong` (every wrong answer with `example`, `question`, `expected`, and `got` or `error`). `accuracy` is `null` when nothing was labelled. A provider failure stops the run and is rethrown with the example id in the message.

## Errors

All errors are subclasses of `Error` with a clear message saying what was wrong and where. None of them ever contains an API key.

| Error | Thrown when | Extra properties |
|-------|-------------|------------------|
| `DecideInputError` | decide() gets unusable input: empty or whitespace-only text, text over `maxInputChars`, or a bad `maxInputChars`. | none |
| `ProviderError` | A provider fails: network error, timeout, non-2xx HTTP status, malformed API reply, or a missing/invalid Anthropic API key. Never retried by decide(). | `provider` (name), `status` (HTTP status, if any), `cause` |
| `QuestionSetError` | A question set is invalid or its file can't be read. The message starts with the file path (or label), then the question and the problem. | `source`, `question`, `field` |
| `ExamplesError` | A labelled examples file is invalid or can't be read. | `source`, `example`, `key` |

`ollamaProvider()` throws a plain `Error` at construction for a missing `model` or an invalid base URL.

```ts
import { ProviderError, decide } from "decidekit";

try {
  const result = await decide({ provider, input, questions });
} catch (error) {
  if (error instanceof ProviderError && error.status === 429) {
    // rate limited: back off and try again later
  }
  throw error;
}
```

## Providers

Creating a provider never makes a network call; the first call happens inside decide().

### `anthropicProvider`

```ts
function anthropicProvider(options?: AnthropicProviderOptions): Provider;
```

Calls the Anthropic Messages API with plain `fetch`, forcing the model to call one tool whose `input_schema` is the answer schema (native structured output).

| Option | Default | Meaning |
|--------|---------|---------|
| `apiKey` | `ANTHROPIC_API_KEY` env var | The API key. |
| `model` | `DECIDEKIT_MODEL` env var, then `claude-haiku-4-5` | Model id. |
| `baseUrl` | `https://api.anthropic.com` | API base URL. |
| `maxTokens` | `1024` | `max_tokens` per call. Must be a positive whole number. |
| `fetch` | global `fetch` | A `fetch` implementation (useful for tests and proxies). |

Key handling:

- With no key, it throws a `ProviderError` **at construction**, not on the first call. `.env` files are never loaded.
- A key containing whitespace or control characters (for example a stray newline from copy-paste) is rejected at construction, without echoing it.
- The key is never included in error messages, in any property of the provider, or in the `cause` of an error: causes are **sanitised copies** of the underlying fetch or body-reader errors, with every form of the key (plain, JSON-escaped, URL-encoded) redacted. Aborts (`AbortError` or the signal's own reason) are rethrown unchanged.
- HTTP errors include a hint for common cases: 401 (check the key), 429 (rate limited), 5xx (server error).

### `ollamaProvider`

```ts
function ollamaProvider(options: OllamaProviderOptions): Provider;
```

Calls a local Ollama server's `/api/chat` with `stream: false`, passing the answer schema as `format` (structured output) and `temperature: 0`.

| Option | Default | Meaning |
|--------|---------|---------|
| `model` | required | Ollama model, for example `"llama3.2"`. (The CLI defaults to `DECIDEKIT_OLLAMA_MODEL`, then `llama3.2`.) |
| `baseUrl` | `OLLAMA_HOST` env var, then `http://localhost:11434` | Server address. Values without a scheme (`127.0.0.1:11434`, `0.0.0.0`, `::1`) get `http://` and port 11434 when missing. |
| `options` | none | Extra Ollama model options (for example `{ num_ctx: 8192 }`), merged over `{ temperature: 0 }`. |
| `fetch` | global `fetch` | A `fetch` implementation. |

A base URL with a username or password (`http://user:pass@host`) is rejected at construction, and credentials are never shown in messages. If the server can't be reached the error suggests `ollama serve`; if the model isn't installed it suggests `ollama pull <model>`.

### The `Provider` interface

To use another backend, implement `Provider`:

```ts
interface Provider {
  readonly name: string;   // reported in meta.provider
  readonly model: string;  // reported in meta.model
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}

interface ProviderRequest {
  readonly prompt: string;              // the complete prompt; send it as the user message
  readonly schema: JSONSchema;          // the shape the reply must match
  readonly signal?: AbortSignal;        // pass it to fetch
}

type ProviderResponse = { readonly text: string } | { readonly json: unknown };
```

Contract:

- `complete()` makes exactly one model call. decide() calls it once per attempt (at most twice per decision).
- Return `{ text }` with the raw model text (decide() extracts the JSON object, tolerating code fences or a sentence around it), or `{ json }` if the API already returned parsed JSON.
- Throw `ProviderError` (with `status` for HTTP failures) for transport problems. A model reply that is wrong or not JSON is **not** a transport failure: return it and let decide() validate and retry.
- Use the `schema` to constrain output where the API supports it. It uses only widely supported keywords (`type`, `properties`, `required`, `additionalProperties`, `enum`, `minimum`, `maximum`, `description`). A retry gets a smaller schema covering only the re-asked questions.
- Never put API keys or other secrets in errors or logs.

See [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-provider) for how to add one to decidekit itself.

Lower-level helpers, mainly for provider authors and tests: `buildPrompt`, `buildSchema`, `answerSchema`, `validateAnswer`, `extractJsonObject`, `SCORE_SUM_TOLERANCE`.

## CLI

```text
decidekit run <set.yaml> <file|-> [--provider anthropic|ollama] [--model <id>] [--json] [--max-input-chars <n>]
decidekit test <set.yaml> <examples.yaml> [--tolerance <n>] [--min-accuracy <pct>] [--provider ...] [--model ...] [--json] [--max-input-chars <n>]
decidekit --help | --version
```

Run `decidekit run --help` or `decidekit test --help` for every option.

Environment variables:

| Variable | Used by | Meaning |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | anthropic | Required. Never printed. |
| `DECIDEKIT_MODEL` | anthropic | Model when `--model` isn't given (default `claude-haiku-4-5`). |
| `OLLAMA_HOST` | ollama | Server address (default `http://localhost:11434`). |
| `DECIDEKIT_OLLAMA_MODEL` | ollama | Model when `--model` isn't given (default `llama3.2`). |

The input must be UTF-8 text. Empty input, or input that looks binary (it contains NUL bytes or is mostly invalid UTF-8), is rejected before any model call.

### Exit codes

| Command | 0 | 1 |
|---------|---|---|
| `run`  | A result was produced, **even if some answers were flagged** (`FAILED` in the table, `"ok": false` in `--json`). Check `ok` for each answer in `--json` output. | Bad arguments, an unreadable or invalid file, unusable input, or a provider error (including a missing API key). |
| `test` | The test ran, whatever the accuracy. | Bad arguments, an unreadable or invalid file, a provider error, or overall accuracy below `--min-accuracy`. |
| `--help`, `--version` | Always. | |

Errors go to stderr as one line starting with `decidekit run:` or `decidekit test:`. Usage errors add a line suggesting `--help`.

## Smoke scripts

Two optional scripts make one tiny **real** call through the built library, to check your setup end to end. They are not part of `npm test`, and they need a build first:

```sh
npm run build
npm run smoke:anthropic   # needs ANTHROPIC_API_KEY; skips (exit 0) without it; costs a fraction of a cent
npm run smoke:ollama      # needs a running Ollama server; skips (exit 0) if none responds or the model is missing
```

`smoke:ollama` uses `DECIDEKIT_OLLAMA_MODEL` (default `llama3.2`) and `OLLAMA_HOST`. Neither script prints your key or loads `.env` files.
