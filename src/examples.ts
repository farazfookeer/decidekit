/**
 * Labelled examples (`<set>.examples.yaml`): loading and validating them
 * against a question set, scoring answers, and measuring accuracy.
 */
import { readFile } from "node:fs/promises";
import { LineCounter, parseDocument } from "yaml";
import { decide } from "./decide.js";
import { describe } from "./describe.js";
import { DecideInputError, ProviderError } from "./errors.js";
import type { Provider } from "./provider.js";
import type { Question, QuestionSet } from "./types.js";

/** An expected answer value: `boolean`, a choice option, or a number. */
export type ExpectedValue = boolean | string | number;

/** One labelled example: a text plus the answers it should get. */
export interface LabelledExample {
  /** The example's `id`, or `#<n>` (its 1-based position) when it has none. */
  readonly id: string;
  /** The text to analyse. */
  readonly input: string;
  /** Expected answers by question key. Questions left out are not scored. */
  readonly expected: Readonly<Record<string, ExpectedValue>>;
}

/**
 * Thrown when a labelled examples file is invalid. The message starts with the
 * source (usually the file path) and names the example and key, for example:
 * `support-triage.examples.yaml: example "double-charge": expected "team": "Bills" is not one of the options (Billing, Technical, Sales, Account)`.
 */
export class ExamplesError extends Error {
  override readonly name = "ExamplesError";
  /** The file path or label the examples came from. */
  readonly source: string;
  /** The offending example id (or `#<n>`), if any. */
  readonly example: string | undefined;
  /** The offending expected key, if any. */
  readonly key: string | undefined;

  constructor(source: string, detail: string, where: { example?: string | undefined; key?: string | undefined } = {}) {
    const ex = where.example === undefined ? "" : `example "${where.example}": `;
    const key = where.key === undefined ? "" : `expected "${where.key}": `;
    super(`${source}: ${ex}${key}${detail}`);
    this.source = source;
    this.example = where.example;
    this.key = where.key;
  }
}

const FILE_FIELDS = new Set(["description", "examples"]);
const EXAMPLE_FIELDS = new Set(["id", "input", "expected"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


/** Checks one expected value against its question. Returns an error detail or undefined. */
function checkExpected(question: Question, value: unknown): string | undefined {
  switch (question.type) {
    case "boolean":
      return typeof value === "boolean" ? undefined : `must be true or false, got ${describe(value)}`;
    case "choice":
      if (typeof value !== "string" || !question.options.includes(value)) {
        return `${typeof value === "string" ? JSON.stringify(value) : describe(value)} is not one of the options (${question.options.join(", ")})`;
      }
      return undefined;
    case "score":
      if (typeof value !== "number" || !Number.isFinite(value)) return `must be a number, got ${describe(value)}`;
      if (value < question.min || value > question.max) {
        return `${value} is outside the range ${question.min} to ${question.max}`;
      }
      if (question.integer === true && !Number.isInteger(value)) return `must be a whole number, got ${value}`;
      return undefined;
  }
}

/**
 * Validates parsed labelled examples (for example from YAML) against a
 * question set. Every expected key must be a question in the set and every
 * value must match its question's type. Throws {@link ExamplesError}.
 */
export function validateExamples(obj: unknown, set: QuestionSet, sourceLabel: string): LabelledExample[] {
  const fail = (detail: string, where: { example?: string; key?: string } = {}): never => {
    throw new ExamplesError(sourceLabel, detail, where);
  };

  if (!isPlainObject(obj)) return fail(`a labelled examples file must be a mapping with an "examples" list, got ${describe(obj)}`);
  for (const field of Object.keys(obj)) {
    if (!FILE_FIELDS.has(field)) fail(`unknown top-level field "${field}" (allowed: ${[...FILE_FIELDS].join(", ")})`);
  }
  const { description, examples } = obj;
  if (description !== undefined && typeof description !== "string") {
    fail(`"description" must be a string, got ${describe(description)}`);
  }
  if (examples === undefined || examples === null) return fail(`no examples: add an "examples" list`);
  if (!Array.isArray(examples)) return fail(`"examples" must be a list, got ${describe(examples)}`);
  if (examples.length === 0) fail(`no examples: "examples" is empty`);

  const known = Object.keys(set.questions);
  const seenIds = new Set<string>();
  const result: LabelledExample[] = [];

  for (const [index, raw] of examples.entries()) {
    let id = `#${index + 1}`;
    if (!isPlainObject(raw)) {
      return fail(`must be a mapping with "input" and "expected", got ${describe(raw)}`, { example: id });
    }
    if (raw.id !== undefined) {
      if ((typeof raw.id !== "string" && typeof raw.id !== "number") || String(raw.id).trim() === "") {
        fail(`"id" must be a non-empty string or number, got ${describe(raw.id)}`, { example: id });
      }
      id = String(raw.id);
    }
    if (seenIds.has(id)) fail(`duplicate id: another example already uses it`, { example: id });
    seenIds.add(id);

    for (const field of Object.keys(raw)) {
      if (!EXAMPLE_FIELDS.has(field)) {
        fail(`unknown field "${field}" (allowed: ${[...EXAMPLE_FIELDS].join(", ")})`, { example: id });
      }
    }
    const { input, expected } = raw;
    if (input === undefined) fail(`missing "input"`, { example: id });
    if (typeof input !== "string" || input.trim() === "") fail(`"input" must be a non-empty string`, { example: id });
    if (expected === undefined) fail(`missing "expected"`, { example: id });
    if (!isPlainObject(expected)) {
      return fail(`"expected" must be a mapping of question keys to answers, got ${describe(expected)}`, { example: id });
    }
    const keys = Object.keys(expected);
    if (keys.length === 0) fail(`"expected" is empty; label at least one question`, { example: id });

    const values: Record<string, ExpectedValue> = {};
    for (const key of keys) {
      const question = set.questions[key];
      if (question === undefined) {
        fail(`no such question in set "${set.name}" (questions: ${known.join(", ")})`, { example: id, key });
      }
      const error = checkExpected(question as Question, expected[key]);
      if (error !== undefined) fail(error, { example: id, key });
      values[key] = expected[key] as ExpectedValue;
    }
    result.push({ id, input: input as string, expected: values });
  }
  return result;
}

/** Parses labelled examples YAML and validates it against `set`. */
export function parseExamples(text: string, set: QuestionSet, sourceLabel: string): LabelledExample[] {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  const [firstError] = doc.errors;
  if (firstError) {
    const pos = lineCounter.linePos(firstError.pos[0]);
    throw new ExamplesError(sourceLabel, `invalid YAML at line ${pos.line}: ${firstError.message}`);
  }
  return validateExamples(doc.toJS(), set, sourceLabel);
}

/** Reads a labelled examples YAML file and validates it against `set`. */
export async function loadExamples(path: string, set: QuestionSet): Promise<LabelledExample[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ExamplesError(path, `cannot read file: ${reason}`);
  }
  return parseExamples(text, set, path);
}

/** An answer as decide() returns it, for scoring. */
export type ScorableAnswer = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

/**
 * Whether an answer matches the expected value. Booleans and choices must be
 * equal; scores must be within `tolerance` (default 0). A failed answer
 * (`ok: false`) is always wrong.
 */
export function isCorrect(question: Question, expected: ExpectedValue, answer: ScorableAnswer, tolerance = 0): boolean {
  if (!answer.ok) return false;
  if (question.type === "score") {
    if (typeof answer.value !== "number" || typeof expected !== "number") return false;
    // A tiny epsilon so a tolerance such as 0.1 isn't defeated by float rounding.
    return Math.abs(answer.value - expected) <= tolerance + 1e-9;
  }
  return answer.value === expected;
}

/** Accuracy for one question, or overall. */
export interface AccuracyCount {
  readonly correct: number;
  /** Number of labelled answers scored. */
  readonly total: number;
  /** correct / total (0 to 1), or null when nothing was labelled. */
  readonly accuracy: number | null;
}

/** One wrong answer. */
export interface WrongAnswer {
  readonly example: string;
  readonly question: string;
  readonly expected: ExpectedValue;
  /** The model's answer, when it gave a valid one. */
  readonly got?: unknown;
  /** Why the answer failed validation, when it did. */
  readonly error?: string;
}

/** The result of {@link measureAccuracy}. */
export interface AccuracyReport {
  /** The question set's name. */
  readonly set: string;
  readonly provider: string;
  readonly model: string;
  readonly tolerance: number;
  /** Number of examples run. */
  readonly examples: number;
  /** Per-question accuracy, in question-set order. */
  readonly questions: Readonly<Record<string, AccuracyCount>>;
  /** Accuracy over every labelled answer of every example. */
  readonly overall: AccuracyCount;
  /** Every wrong answer, in example order. */
  readonly wrong: readonly WrongAnswer[];
}

/** Options for {@link measureAccuracy}. */
export interface MeasureAccuracyOptions {
  readonly provider: Provider;
  readonly set: QuestionSet;
  readonly examples: readonly LabelledExample[];
  /** How far a score answer may be from the expected value and still count as correct. Default 0. */
  readonly tolerance?: number;
  /** Passed to decide(). */
  readonly maxInputChars?: number;
  /** Aborts the run. */
  readonly signal?: AbortSignal;
}

function count(correct: number, total: number): AccuracyCount {
  return { correct, total, accuracy: total === 0 ? null : correct / total };
}

function withExample(error: unknown, id: string): Error {
  const message = `example "${id}": ${error instanceof Error ? error.message : String(error)}`;
  if (error instanceof ProviderError) {
    return new ProviderError(message, { provider: error.provider, status: error.status, cause: error });
  }
  if (error instanceof DecideInputError) return new DecideInputError(message, { cause: error });
  return new Error(message, { cause: error });
}

/**
 * Runs decide() on every labelled example (one at a time) and scores the
 * answers. Provider failures stop the run and are rethrown with the example
 * id in the message; invalid answers just count as wrong.
 */
export async function measureAccuracy(options: MeasureAccuracyOptions): Promise<AccuracyReport> {
  const { provider, set, examples, maxInputChars, signal } = options;
  const tolerance = options.tolerance ?? 0;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError(`measureAccuracy: "tolerance" must be a number 0 or above, got ${String(tolerance)}`);
  }
  const keys = Object.keys(set.questions);
  const tallies = new Map(keys.map((key) => [key, { correct: 0, total: 0 }]));
  const wrong: WrongAnswer[] = [];

  for (const example of examples) {
    let answers: Record<string, ScorableAnswer>;
    try {
      const result = await decide({
        provider,
        input: example.input,
        questions: set,
        ...(maxInputChars === undefined ? {} : { maxInputChars }),
        ...(signal === undefined ? {} : { signal }),
      });
      answers = result.answers as Record<string, ScorableAnswer>;
    } catch (error) {
      if (signal?.aborted === true || (error instanceof Error && error.name === "AbortError")) throw error;
      throw withExample(error, example.id);
    }
    for (const key of keys) {
      const expected = example.expected[key];
      if (expected === undefined) continue;
      const tally = tallies.get(key) as { correct: number; total: number };
      const question = set.questions[key] as Question;
      const answer = answers[key] ?? { ok: false, error: "no answer" };
      tally.total++;
      if (isCorrect(question, expected, answer, tolerance)) {
        tally.correct++;
      } else {
        wrong.push(
          answer.ok
            ? { example: example.id, question: key, expected, got: answer.value }
            : { example: example.id, question: key, expected, error: answer.error },
        );
      }
    }
  }

  const questions: Record<string, AccuracyCount> = {};
  let correct = 0;
  let total = 0;
  for (const [key, tally] of tallies) {
    questions[key] = count(tally.correct, tally.total);
    correct += tally.correct;
    total += tally.total;
  }
  return {
    set: set.name,
    provider: provider.name,
    model: provider.model,
    tolerance,
    examples: examples.length,
    questions,
    overall: count(correct, total),
    wrong,
  };
}
