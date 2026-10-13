import { readFile } from "node:fs/promises";
import { LineCounter, isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { Node as YamlNode } from "yaml";
import { describe } from "./describe.js";
import { QUESTION_KEY_PATTERN, QUESTION_TYPES } from "./types.js";
import type {
  BooleanQuestion,
  ChoiceQuestion,
  Question,
  QuestionSet,
  QuestionType,
  ScoreQuestion,
} from "./types.js";

/**
 * Thrown when a question set is invalid. The message always starts with the
 * source (usually the file path) and, where relevant, names the question and
 * field, for example:
 * `support-triage.yaml: question "team": choice needs at least 2 options`.
 */
export class QuestionSetError extends Error {
  override readonly name = "QuestionSetError";
  /** The file path or label the set came from. */
  readonly source: string;
  /** The offending question key, if the problem is inside a question. */
  readonly question: string | undefined;
  /** The offending field, if known. */
  readonly field: string | undefined;

  constructor(
    source: string,
    detail: string,
    where: { question?: string | undefined; field?: string | undefined; cause?: unknown } = {},
  ) {
    const prefix = where.question === undefined ? "" : `question "${where.question}": `;
    super(`${source}: ${prefix}${detail}`, where.cause === undefined ? undefined : { cause: where.cause });
    this.source = source;
    this.question = where.question;
    this.field = where.field;
  }
}

const SET_FIELDS = new Set(["name", "version", "description", "questions"]);
const QUESTION_FIELDS: Record<QuestionType, ReadonlySet<string>> = {
  boolean: new Set(["type", "instructions"]),
  choice: new Set(["type", "instructions", "options"]),
  score: new Set(["type", "instructions", "min", "max", "integer"]),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


function isQuestionType(value: unknown): value is QuestionType {
  return typeof value === "string" && (QUESTION_TYPES as readonly string[]).includes(value);
}

function validateQuestion(source: string, key: string, raw: unknown): Question {
  const fail = (detail: string, field?: string): never => {
    throw new QuestionSetError(source, detail, { question: key, field });
  };

  if (!isPlainObject(raw)) {
    return fail(`must be a mapping with "type" and "instructions", got ${describe(raw)}`);
  }

  const { type, instructions } = raw;
  if (type === undefined) return fail(`missing "type" (one of ${QUESTION_TYPES.join(", ")})`, "type");
  if (!isQuestionType(type)) {
    return fail(`unknown type ${JSON.stringify(type)} (expected one of ${QUESTION_TYPES.join(", ")})`, "type");
  }
  if (instructions === undefined) return fail(`missing "instructions"`, "instructions");
  if (typeof instructions !== "string" || instructions.trim() === "") {
    return fail(`"instructions" must be a non-empty string`, "instructions");
  }

  for (const field of Object.keys(raw)) {
    if (!QUESTION_FIELDS[type].has(field)) {
      fail(
        `unknown field "${field}" for a ${type} question (allowed: ${[...QUESTION_FIELDS[type]].join(", ")})`,
        field,
      );
    }
  }

  switch (type) {
    case "boolean": {
      const question: BooleanQuestion = { type, instructions };
      return question;
    }
    case "choice": {
      const { options } = raw;
      if (options === undefined) return fail(`choice needs an "options" list`, "options");
      if (!Array.isArray(options)) return fail(`"options" must be a list, got ${describe(options)}`, "options");
      if (options.length < 2) return fail(`choice needs at least 2 options`, "options");
      const seen = new Set<string>();
      for (const [index, option] of options.entries()) {
        if (typeof option !== "string" || option.trim() === "") {
          fail(`option ${index + 1} must be a non-empty string, got ${describe(option)}`, "options");
        }
        const text = option as string;
        if (seen.has(text)) fail(`duplicate option ${JSON.stringify(text)}`, "options");
        seen.add(text);
      }
      const question: ChoiceQuestion = { type, instructions, options: [...seen] };
      return question;
    }
    case "score": {
      const { min, max, integer } = raw;
      for (const [field, value] of [["min", min], ["max", max]] as const) {
        if (value === undefined) fail(`score needs "${field}"`, field);
        if (typeof value !== "number" || !Number.isFinite(value)) {
          fail(`"${field}" must be a number, got ${describe(value)}`, field);
        }
      }
      const lo = min as number;
      const hi = max as number;
      if (lo >= hi) return fail(`score "min" (${lo}) must be less than "max" (${hi})`, "min");
      if (integer !== undefined && typeof integer !== "boolean") {
        return fail(`"integer" must be true or false, got ${describe(integer)}`, "integer");
      }
      if (integer === true && (!Number.isInteger(lo) || !Number.isInteger(hi))) {
        return fail(`"min" and "max" must be whole numbers when "integer" is true`, "integer");
      }
      const question: ScoreQuestion =
        integer === undefined ? { type, instructions, min: lo, max: hi } : { type, instructions, min: lo, max: hi, integer };
      return question;
    }
  }
}

/**
 * Validates a plain object (parsed YAML or JSON, or a set written inline) and
 * returns a typed, normalised copy. Throws `QuestionSetError` naming
 * `sourceLabel` and the offending question and field.
 */
export function validateQuestionSet(obj: unknown, sourceLabel: string): QuestionSet {
  const fail = (detail: string, field?: string): never => {
    throw new QuestionSetError(sourceLabel, detail, { field });
  };

  if (!isPlainObject(obj)) return fail(`a question set must be a mapping, got ${describe(obj)}`);

  for (const field of Object.keys(obj)) {
    if (!SET_FIELDS.has(field)) {
      fail(`unknown top-level field "${field}" (allowed: ${[...SET_FIELDS].join(", ")})`, field);
    }
  }

  const { name, version, description, questions } = obj;
  if (name === undefined) fail(`missing "name"`, "name");
  if (typeof name !== "string" || name.trim() === "") fail(`"name" must be a non-empty string`, "name");
  if (version !== undefined && typeof version !== "string" && typeof version !== "number") {
    fail(`"version" must be a string or number, got ${describe(version)}`, "version");
  }
  if (description !== undefined && typeof description !== "string") {
    fail(`"description" must be a string, got ${describe(description)}`, "description");
  }
  if (questions === undefined || questions === null) fail(`no questions: add a "questions" mapping`, "questions");
  if (!isPlainObject(questions)) {
    return fail(`"questions" must be a mapping of question keys to questions, got ${describe(questions)}`, "questions");
  }
  const keys = Object.keys(questions);
  if (keys.length === 0) fail(`no questions: "questions" is empty`, "questions");

  const validated: Record<string, Question> = {};
  for (const key of keys) {
    if (!QUESTION_KEY_PATTERN.test(key)) {
      throw new QuestionSetError(
        sourceLabel,
        `bad key name: must start with a lowercase letter and contain only lowercase letters, digits and underscores`,
        { question: key },
      );
    }
    validated[key] = validateQuestion(sourceLabel, key, questions[key]);
  }

  const set: {
    name: string;
    version?: string | number;
    description?: string;
    questions: Record<string, Question>;
  } = { name: name as string, questions: validated };
  if (version !== undefined) set.version = version as string | number;
  if (description !== undefined) set.description = description as string;
  return set;
}

function keyText(key: unknown): string {
  return isScalar(key) ? String(key.value) : String(key);
}

/**
 * Walks the YAML tree and reports the first duplicate mapping key, with its
 * path, so the error can name the question involved.
 */
function findDuplicateKey(
  node: unknown,
  path: string[],
): { key: string; path: string[]; offset: number | undefined } | undefined {
  if (isMap(node)) {
    const seen = new Set<string>();
    for (const pair of node.items) {
      const key = keyText(pair.key);
      if (seen.has(key)) {
        const range = isScalar(pair.key) ? pair.key.range : undefined;
        return { key, path, offset: range?.[0] };
      }
      seen.add(key);
      const found = findDuplicateKey(pair.value, [...path, key]);
      if (found) return found;
    }
  } else if (isSeq(node)) {
    for (const [index, item] of node.items.entries()) {
      const found = findDuplicateKey(item, [...path, String(index)]);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Parses question set YAML text and validates it. `sourceLabel` (usually the
 * file path) is used in error messages. Duplicate keys are an error.
 */
export function parseQuestionSet(text: string, sourceLabel: string): QuestionSet {
  const lineCounter = new LineCounter();
  // uniqueKeys: false so we can walk the tree ourselves and say exactly which
  // question has the duplicate; findDuplicateKey enforces uniqueness instead.
  const doc = parseDocument(text, { uniqueKeys: false, lineCounter, prettyErrors: false });

  const [firstError] = doc.errors;
  if (firstError) {
    const pos = lineCounter.linePos(firstError.pos[0]);
    throw new QuestionSetError(sourceLabel, `invalid YAML at line ${pos.line}: ${firstError.message}`);
  }

  const dup = findDuplicateKey(doc.contents as YamlNode | null, []);
  if (dup) {
    const at = dup.offset === undefined ? "" : ` (line ${lineCounter.linePos(dup.offset).line})`;
    const [top, question, ...rest] = dup.path;
    if (top === "questions" && question === undefined) {
      throw new QuestionSetError(sourceLabel, `duplicate key: this question is defined more than once${at}`, {
        question: dup.key,
      });
    }
    if (top === "questions" && question !== undefined) {
      const inner = rest.length > 0 ? ` in "${rest.join(".")}"` : "";
      throw new QuestionSetError(sourceLabel, `duplicate key "${dup.key}"${inner}${at}`, {
        question,
        field: dup.key,
      });
    }
    const where = dup.path.length > 0 ? ` in "${dup.path.join(".")}"` : "";
    throw new QuestionSetError(sourceLabel, `duplicate key "${dup.key}"${where}${at}`, { field: dup.key });
  }

  return validateQuestionSet(doc.toJS(), sourceLabel);
}

/**
 * Reads a question set YAML file and validates it. Errors (including a
 * missing file) are `QuestionSetError`s whose message starts with `path`.
 */
export async function loadQuestionSet(path: string): Promise<QuestionSet> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new QuestionSetError(path, `cannot read file: ${reason}`, { cause: error });
  }
  return parseQuestionSet(text, path);
}
