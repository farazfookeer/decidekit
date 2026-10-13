/**
 * Extracting JSON from model text and validating individual answers.
 */
import type { Question } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Returns the balanced `{...}` substring starting at `start`, string-aware. */
function balancedObjectAt(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Finds one JSON object in model output. Accepts bare JSON, JSON inside a
 * Markdown code fence (```json ... ```), or JSON with prose around it.
 * Returns `undefined` when no JSON object can be found.
 */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const direct = tryParseObject(trimmed);
  if (direct) return direct;

  const fence = /```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g;
  for (const match of trimmed.matchAll(fence)) {
    const inner = match[1];
    if (inner === undefined) continue;
    const fenced = tryParseObject(inner.trim());
    if (fenced) return fenced;
  }

  for (let start = trimmed.indexOf("{"); start !== -1; start = trimmed.indexOf("{", start + 1)) {
    const candidate = balancedObjectAt(trimmed, start);
    if (candidate === undefined) continue;
    const parsed = tryParseObject(candidate);
    if (parsed) return parsed;
  }
  return undefined;
}

/** A validated answer value, before decide() attaches `ok: true`. */
export type ValidAnswer =
  | { readonly value: boolean; readonly confidence: number }
  | { readonly value: string; readonly scores: Readonly<Record<string, number>> }
  | { readonly value: number };

/** The outcome of validating one answer. */
export type AnswerCheck = { readonly ok: true; readonly answer: ValidAnswer } | { readonly ok: false; readonly error: string };

function show(value: unknown): string {
  if (value === undefined) return "nothing";
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json.length > 80 ? `${json.slice(0, 77)}...` : json;
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Choice scores whose sum is within this range are renormalised to sum to 1. */
export const SCORE_SUM_TOLERANCE = { min: 0.9, max: 1.1 } as const;

/**
 * Validates one raw answer against its question. Errors are short,
 * human-readable reasons (they are also shown to the model on retry).
 */
export function validateAnswer(question: Question, raw: unknown): AnswerCheck {
  const fail = (error: string): AnswerCheck => ({ ok: false, error });
  if (raw === undefined) return fail("missing answer");
  if (!isPlainObject(raw)) return fail(`expected an object with "value", got ${show(raw)}`);
  const { value } = raw;

  switch (question.type) {
    case "boolean": {
      if (typeof value !== "boolean") return fail(`"value" must be true or false, got ${show(value)}`);
      const { confidence } = raw;
      if (!isUnitNumber(confidence)) return fail(`"confidence" must be a number from 0 to 1, got ${show(confidence)}`);
      return { ok: true, answer: { value, confidence } };
    }
    case "choice": {
      if (typeof value !== "string" || !question.options.includes(value)) {
        return fail(`"value" must be one of ${question.options.map((o) => JSON.stringify(o)).join(", ")}, got ${show(value)}`);
      }
      const { scores } = raw;
      if (!isPlainObject(scores)) return fail(`"scores" must be an object with a score for every option, got ${show(scores)}`);
      let sum = 0;
      for (const option of question.options) {
        const score = scores[option];
        if (!isUnitNumber(score)) return fail(`"scores" for ${JSON.stringify(option)} must be a number from 0 to 1, got ${show(score)}`);
        sum += score;
      }
      // The epsilon keeps sums like 0.6 + 0.3 (0.8999...) inside the range.
      if (sum < SCORE_SUM_TOLERANCE.min - 1e-9 || sum > SCORE_SUM_TOLERANCE.max + 1e-9) {
        return fail(`"scores" must sum to 1 (got ${Number(sum.toFixed(4))})`);
      }
      const normalised: Record<string, number> = {};
      for (const option of question.options) normalised[option] = (scores[option] as number) / sum;
      return { ok: true, answer: { value, scores: normalised } };
    }
    case "score": {
      if (typeof value !== "number" || !Number.isFinite(value)) return fail(`"value" must be a number, got ${show(value)}`);
      if (value < question.min || value > question.max) {
        return fail(`"value" must be between ${question.min} and ${question.max}, got ${value}`);
      }
      if (question.integer === true && !Number.isInteger(value)) return fail(`"value" must be a whole number, got ${value}`);
      return { ok: true, answer: { value } };
    }
  }
}
