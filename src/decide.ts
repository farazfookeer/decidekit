/**
 * The decide() engine: asks a provider every question in one call, validates
 * each answer, and retries the invalid ones once.
 */
import { DecideInputError, ProviderError } from "./errors.js";
import { extractJsonObject, validateAnswer } from "./parse.js";
import type { ValidAnswer } from "./parse.js";
import { buildPrompt } from "./prompt.js";
import type { Provider, ProviderResponse } from "./provider.js";
import { validateQuestionSet } from "./questionSet.js";
import { buildSchema } from "./schema.js";
import type { BooleanQuestion, ChoiceQuestion, Question, QuestionSet, ScoreQuestion } from "./types.js";

/** A map of question keys to questions. */
export type Questions = Readonly<Record<string, Question>>;

/**
 * Identity helper that keeps the literal types of inline questions, so
 * decide() can infer exact answer types (for example a choice's value is the
 * union of its options).
 *
 * @example
 * ```ts
 * const questions = defineQuestions({
 *   urgent: { type: "boolean", instructions: "Does this need a reply today?" },
 *   team: { type: "choice", instructions: "Which team?", options: ["Billing", "Technical"] },
 * });
 * ```
 */
export function defineQuestions<const Q extends Questions>(questions: Q): Q {
  return questions;
}

/** A failed answer: the model never gave a valid one. */
export interface FailedAnswer {
  readonly ok: false;
  /** Why the answer is invalid (after the retry). */
  readonly error: string;
}

/** A valid boolean answer. */
export interface BooleanAnswer {
  readonly ok: true;
  readonly value: boolean;
  /** The model's own estimate (0 to 1) that the answer is correct. Uncalibrated. */
  readonly confidence: number;
}

/** A valid choice answer. */
export interface ChoiceAnswer<O extends string = string> {
  readonly ok: true;
  /** The chosen option. */
  readonly value: O;
  /** The model's own estimate (0 to 1) for every option, normalised to sum to 1. Uncalibrated. */
  readonly scores: Readonly<Record<O, number>>;
}

/** A valid score answer. */
export interface ScoreAnswer {
  readonly ok: true;
  /** A number within the question's min..max (a whole number if `integer`). */
  readonly value: number;
}

/** The options of a choice question as a union of literals (or `string`). */
export type OptionOf<Q extends ChoiceQuestion> = Q["options"][number];

/** The successful answer type for a question. */
export type ValidAnswerFor<Q extends Question> = Q extends BooleanQuestion
  ? BooleanAnswer
  : Q extends ChoiceQuestion
    ? ChoiceAnswer<OptionOf<Q>>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : never;

/** The answer type for a question: valid, or failed with an error. */
export type AnswerFor<Q extends Question> = ValidAnswerFor<Q> | FailedAnswer;

/** The answer value type for a question (`boolean`, an option union, or `number`). */
export type AnswerValue<Q extends Question> = ValidAnswerFor<Q>["value"];

/** Answers keyed by question. */
export type Answers<Q extends Questions> = { readonly [K in keyof Q]: AnswerFor<Q[K]> };

/** Details about how a decision was made. */
export interface DecideMeta {
  /** `provider.name`. */
  readonly provider: string;
  /** `provider.model`. */
  readonly model: string;
  /** Wall-clock time across all attempts, in milliseconds. */
  readonly latencyMs: number;
  /** Number of provider calls made: 1, or 2 when a retry was needed. */
  readonly attempts: number;
}

/** The result of decide(). */
export interface DecideResult<Q extends Questions = Questions> {
  readonly answers: Answers<Q>;
  readonly meta: DecideMeta;
}

/** Options for decide(). */
export interface DecideOptions<Q extends Questions = Questions> {
  /** The LLM backend. */
  readonly provider: Provider;
  /** The text to analyse. Must not be empty or whitespace only. */
  readonly input: string;
  /** A question set (for example from loadQuestionSet) or an inline questions map. */
  readonly questions: Q | QuestionSet<Q>;
  /** If set, input longer than this many characters is rejected (never truncated). */
  readonly maxInputChars?: number;
  /** Aborts the provider call. */
  readonly signal?: AbortSignal;
}

function isQuestionSet(value: unknown): value is QuestionSet {
  if (typeof value !== "object" || value === null) return false;
  const { name, questions } = value as Record<string, unknown>;
  return typeof name === "string" && typeof questions === "object" && questions !== null;
}

function resolveQuestions(questions: Questions | QuestionSet): Questions {
  if (isQuestionSet(questions)) return validateQuestionSet(questions, `question set "${questions.name}"`).questions;
  return validateQuestionSet({ name: "inline", questions }, "inline questions").questions;
}

function checkInput(input: unknown, maxInputChars: number | undefined): string {
  if (typeof input !== "string") throw new DecideInputError(`decide: "input" must be a string, got ${typeof input}`);
  if (input.trim() === "") throw new DecideInputError(`decide: "input" is empty; pass the text to analyse`);
  if (maxInputChars !== undefined) {
    if (!Number.isInteger(maxInputChars) || maxInputChars < 1) {
      throw new DecideInputError(`decide: "maxInputChars" must be a positive whole number, got ${String(maxInputChars)}`);
    }
    if (input.length > maxInputChars) {
      throw new DecideInputError(
        `decide: input is ${input.length} characters, more than maxInputChars (${maxInputChars}); shorten it or raise the limit`,
      );
    }
  }
  return input;
}

async function callProvider(
  provider: Provider,
  prompt: string,
  schema: ReturnType<typeof buildSchema>,
  signal: AbortSignal | undefined,
): Promise<ProviderResponse> {
  try {
    return await provider.complete({ prompt, schema, signal });
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (signal?.aborted === true || (error instanceof Error && error.name === "AbortError")) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new ProviderError(`provider "${provider.name}" failed: ${reason}`, { provider: provider.name, cause: error });
  }
}

function responseObject(response: ProviderResponse): Record<string, unknown> | undefined {
  if ("json" in response) {
    const { json } = response;
    if (typeof json === "string") return extractJsonObject(json);
    return typeof json === "object" && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
  }
  return typeof response.text === "string" ? extractJsonObject(response.text) : undefined;
}

/** Runs one attempt and validates the answers for `keys`. */
async function attempt(
  provider: Provider,
  questions: Questions,
  keys: readonly string[],
  input: string,
  signal: AbortSignal | undefined,
  previousErrors: Record<string, string> | undefined,
): Promise<{ valid: Record<string, ValidAnswer>; errors: Record<string, string> }> {
  const schema = buildSchema(questions, keys);
  const prompt = buildPrompt(
    previousErrors === undefined ? { questions, keys, input, schema } : { questions, keys, input, schema, previousErrors },
  );
  const response = await callProvider(provider, prompt, schema, signal);
  const object = responseObject(response);
  const valid: Record<string, ValidAnswer> = {};
  const errors: Record<string, string> = {};
  for (const key of keys) {
    if (object === undefined) {
      errors[key] = "the response was not a JSON object";
      continue;
    }
    const question = questions[key] as Question;
    const check = validateAnswer(question, object[key]);
    if (check.ok) valid[key] = check.answer;
    else errors[key] = check.error;
  }
  return { valid, errors };
}

/**
 * Answers every question about `input` with one provider call, validating
 * each answer against its type.
 *
 * - If any answers are missing or invalid (or the reply is not JSON), decide()
 *   retries once, re-asking only those questions and showing the model the
 *   validation errors. Answers still invalid after the retry come back as
 *   `{ ok: false, error }`. Extra keys in the reply are ignored.
 * - Provider failures (`ProviderError`) propagate and are never retried here.
 * - Empty input, or input over `maxInputChars`, throws `DecideInputError`.
 * - Invalid inline questions throw `QuestionSetError`.
 *
 * For inline questions (or {@link defineQuestions}), the answer types are
 * inferred from the question literals.
 */
export async function decide<const Q extends Questions>(options: DecideOptions<Q>): Promise<DecideResult<Q>> {
  const { provider, signal } = options;
  const input = checkInput(options.input, options.maxInputChars);
  const questions = resolveQuestions(options.questions);
  const keys = Object.keys(questions);

  const started = performance.now();
  const first = await attempt(provider, questions, keys, input, signal, undefined);
  const valid = { ...first.valid };
  let errors = first.errors;
  let attempts = 1;

  const retryKeys = keys.filter((key) => key in errors);
  if (retryKeys.length > 0) {
    attempts = 2;
    const second = await attempt(provider, questions, retryKeys, input, signal, errors);
    Object.assign(valid, second.valid);
    errors = second.errors;
  }
  const latencyMs = Math.round(performance.now() - started);

  const answers: Record<string, unknown> = {};
  for (const key of keys) {
    const answer = valid[key];
    answers[key] =
      answer !== undefined ? { ok: true, ...answer } : { ok: false, error: `${errors[key] ?? "invalid answer"} (after retry)` };
  }

  return {
    // The runtime shape matches Answers<Q>: one entry per key, built from the
    // validated question of that key.
    answers: answers as Answers<Q>,
    meta: { provider: provider.name, model: provider.model, latencyMs, attempts },
  };
}
