/**
 * decidekit public API.
 */

/** The package version. Must equal "version" in package.json (tests/packageMeta.test.ts checks this). */
export const VERSION = "0.0.0";

export type {
  BooleanQuestion,
  ChoiceQuestion,
  Question,
  QuestionBase,
  QuestionSet,
  QuestionType,
  ScoreQuestion,
} from "./types.js";
export { QUESTION_KEY_PATTERN, QUESTION_TYPES } from "./types.js";
export {
  QuestionSetError,
  loadQuestionSet,
  parseQuestionSet,
  validateQuestionSet,
} from "./questionSet.js";

export type { JSONSchema, Provider, ProviderRequest, ProviderResponse } from "./provider.js";
export { DecideInputError, ProviderError } from "./errors.js";
export type { ProviderErrorOptions } from "./errors.js";
export { answerSchema, buildSchema } from "./schema.js";
export { SCORE_SUM_TOLERANCE, extractJsonObject, validateAnswer } from "./parse.js";
export type { AnswerCheck, ValidAnswer } from "./parse.js";
export { buildPrompt } from "./prompt.js";
export type { PromptOptions } from "./prompt.js";
export { decide, defineQuestions } from "./decide.js";
export type {
  AnswerFor,
  AnswerValue,
  Answers,
  BooleanAnswer,
  ChoiceAnswer,
  DecideMeta,
  DecideOptions,
  DecideResult,
  FailedAnswer,
  OptionOf,
  Questions,
  ScoreAnswer,
  ValidAnswerFor,
} from "./decide.js";
export { ollamaProvider, type OllamaProviderOptions } from "./providers/ollama.js";
export { anthropicProvider, type AnthropicProviderOptions } from "./providers/anthropic.js";
export * from "./examples.js";
