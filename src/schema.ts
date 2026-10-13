/**
 * Builds the JSON Schema a model's response must match.
 */
import type { JSONSchema } from "./provider.js";
import type { Question } from "./types.js";

const confidenceSchema: JSONSchema = {
  type: "number",
  minimum: 0,
  maximum: 1,
  description: "Your own estimate (0 to 1) that this answer is correct.",
};

/** The JSON Schema for one question's answer object. */
export function answerSchema(question: Question): JSONSchema {
  switch (question.type) {
    case "boolean":
      return {
        type: "object",
        properties: { value: { type: "boolean" }, confidence: confidenceSchema },
        required: ["value", "confidence"],
        additionalProperties: false,
      };
    case "choice": {
      const scoreProps: Record<string, JSONSchema> = {};
      for (const option of question.options) scoreProps[option] = { type: "number", minimum: 0, maximum: 1 };
      return {
        type: "object",
        properties: {
          value: { type: "string", enum: [...question.options] },
          scores: {
            type: "object",
            description: "Your own estimate (0 to 1) for every option. The scores should sum to 1.",
            properties: scoreProps,
            required: [...question.options],
            additionalProperties: false,
          },
        },
        required: ["value", "scores"],
        additionalProperties: false,
      };
    }
    case "score":
      return {
        type: "object",
        properties: {
          value: { type: question.integer === true ? "integer" : "number", minimum: question.min, maximum: question.max },
        },
        required: ["value"],
        additionalProperties: false,
      };
  }
}

/**
 * The JSON Schema for a response answering `keys` (default: every question):
 * an object with one required property per question.
 */
export function buildSchema(
  questions: Readonly<Record<string, Question>>,
  keys: readonly string[] = Object.keys(questions),
): JSONSchema {
  const properties: Record<string, JSONSchema> = {};
  for (const key of keys) {
    const question = questions[key];
    if (question === undefined) throw new Error(`buildSchema: unknown question "${key}"`);
    properties[key] = { ...answerSchema(question), description: question.instructions };
  }
  return { type: "object", properties, required: [...keys], additionalProperties: false };
}
