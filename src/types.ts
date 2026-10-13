/**
 * Core question and question set types.
 *
 * A question set is a named collection of questions keyed by name. The same
 * types describe sets loaded from YAML and sets written inline in TypeScript.
 */

/** Fields every question has, whatever its type. */
export interface QuestionBase {
  /** Plain-language instructions telling the model what to decide. */
  readonly instructions: string;
}

/** A yes/no question. The answer is a `boolean`. */
export interface BooleanQuestion extends QuestionBase {
  readonly type: "boolean";
}

/** Pick exactly one of a fixed list of options. The answer is one option. */
export interface ChoiceQuestion extends QuestionBase {
  readonly type: "choice";
  /** At least 2 distinct, non-empty strings. */
  readonly options: readonly string[];
}

/** A number between `min` and `max` (inclusive). */
export interface ScoreQuestion extends QuestionBase {
  readonly type: "score";
  readonly min: number;
  readonly max: number;
  /** When true, the answer must be a whole number. */
  readonly integer?: boolean;
}

/** Any question, discriminated by `type`. */
export type Question = BooleanQuestion | ChoiceQuestion | ScoreQuestion;

/** The question type names: `"boolean" | "choice" | "score"`. */
export type QuestionType = Question["type"];

/** Every supported question type, in documentation order. */
export const QUESTION_TYPES: readonly QuestionType[] = ["boolean", "choice", "score"];

/** Question keys must match this pattern (lowercase, digits, underscores). */
export const QUESTION_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/** A named collection of questions, keyed by question name. */
export interface QuestionSet<
  Q extends Readonly<Record<string, Question>> = Readonly<Record<string, Question>>,
> {
  readonly name: string;
  readonly version?: string | number;
  readonly description?: string;
  readonly questions: Q;
}
