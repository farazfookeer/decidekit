import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  QuestionSetError,
  loadQuestionSet,
  parseQuestionSet,
  validateQuestionSet,
} from "../src/index.js";
import type { QuestionSet } from "../src/index.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/question-sets/${name}`, import.meta.url));

async function loadError(name: string): Promise<QuestionSetError> {
  try {
    await loadQuestionSet(fixture(name));
  } catch (error) {
    expect(error).toBeInstanceOf(QuestionSetError);
    return error as QuestionSetError;
  }
  throw new Error(`expected ${name} to fail`);
}

describe("loadQuestionSet: valid files", () => {
  it("loads every question type with typed fields", async () => {
    const set = await loadQuestionSet(fixture("support-triage.yaml"));
    expect(set).toEqual({
      name: "support-triage",
      version: 1,
      description: "Route incoming support emails.",
      questions: {
        urgent: { type: "boolean", instructions: "Does this need a reply today?" },
        team: {
          type: "choice",
          instructions: "Which team should handle it?",
          options: ["Billing", "Technical", "Sales", "Account"],
        },
        frustration: {
          type: "score",
          instructions: "How frustrated is the customer?",
          min: 1,
          max: 5,
          integer: true,
        },
      },
    });
  });

  it("narrows questions by type", async () => {
    const set = await loadQuestionSet(fixture("support-triage.yaml"));
    const team = set.questions["team"];
    if (team?.type !== "choice") throw new Error("expected a choice question");
    expect(team.options).toHaveLength(4);
  });

  it("treats version, description and integer as optional", async () => {
    const set = await loadQuestionSet(fixture("minimal.yaml"));
    expect(set).toEqual({
      name: "minimal",
      questions: {
        refunded: { type: "boolean", instructions: "Was the customer refunded?" },
        confidence_level: { type: "score", instructions: "How sure is the author?", min: 0, max: 1 },
      },
    });
    expect("version" in set).toBe(false);
    expect("integer" in (set.questions["confidence_level"] ?? {})).toBe(false);
  });
});

describe("loadQuestionSet: invalid files name the file and the problem", () => {
  const cases: Array<{ file: string; question?: string; field?: string; message: RegExp }> = [
    { file: "no-questions.yaml", field: "questions", message: /no questions/ },
    { file: "missing-questions.yaml", field: "questions", message: /no questions/ },
    { file: "unknown-type.yaml", question: "mood", field: "type", message: /unknown type "emotion"/ },
    {
      file: "choice-one-option.yaml",
      question: "team",
      field: "options",
      message: /question "team": choice needs at least 2 options$/,
    },
    {
      file: "choice-duplicate-options.yaml",
      question: "team",
      field: "options",
      message: /duplicate option "Billing"/,
    },
    {
      file: "choice-non-string-option.yaml",
      question: "team",
      field: "options",
      message: /option 2 must be a non-empty string/,
    },
    {
      file: "duplicate-question.yaml",
      question: "urgent",
      message: /question "urgent": duplicate key: this question is defined more than once \(line 6\)/,
    },
    {
      file: "duplicate-field.yaml",
      question: "team",
      field: "options",
      message: /question "team": duplicate key "options" \(line 7\)/,
    },
    {
      file: "score-min-max.yaml",
      question: "frustration",
      field: "min",
      message: /"min" \(5\) must be less than "max" \(5\)/,
    },
    {
      file: "missing-instructions.yaml",
      question: "urgent",
      field: "instructions",
      message: /missing "instructions"/,
    },
    { file: "bad-key.yaml", question: "Urgent-Flag", message: /question "Urgent-Flag": bad key name/ },
    { file: "missing-name.yaml", field: "name", message: /missing "name"/ },
    { file: "invalid-yaml.yaml", message: /invalid YAML at line \d+/ },
  ];

  for (const { file, question, field, message } of cases) {
    it(file, async () => {
      const error = await loadError(file);
      expect(error.message.startsWith(`${fixture(file)}: `)).toBe(true);
      expect(error.message).toMatch(message);
      expect(error.source).toBe(fixture(file));
      expect(error.question).toBe(question);
      expect(error.field).toBe(field);
    });
  }

  it("reports a missing file with its path", async () => {
    const error = await loadError("does-not-exist.yaml");
    expect(error.message).toContain("does-not-exist.yaml: cannot read file");
  });
});

describe("validateQuestionSet", () => {
  const valid = {
    name: "inline",
    questions: { urgent: { type: "boolean", instructions: "Urgent?" } },
  };

  it("accepts an inline object and returns a typed set", () => {
    const set: QuestionSet = validateQuestionSet(valid, "inline set");
    expect(set).toEqual(valid);
  });

  it("uses the source label in errors", () => {
    expect(() =>
      validateQuestionSet(
        { name: "x", questions: { team: { type: "choice", instructions: "Team?", options: ["A"] } } },
        "support-triage.yaml",
      ),
    ).toThrow('support-triage.yaml: question "team": choice needs at least 2 options');
  });

  const bad: Array<[string, unknown, RegExp]> = [
    ["a non-object", "hello", /must be a mapping/],
    ["an empty name", { ...valid, name: "  " }, /"name" must be a non-empty string/],
    ["a non-string description", { ...valid, description: 3 }, /"description" must be a string/],
    ["an unknown top-level field", { ...valid, extra: true }, /unknown top-level field "extra"/],
    ["questions as a list", { name: "x", questions: [] }, /"questions" must be a mapping/],
    ["a question that is not a mapping", { name: "x", questions: { a: "yes" } }, /question "a": must be a mapping/],
    ["a missing type", { name: "x", questions: { a: { instructions: "A?" } } }, /question "a": missing "type"/],
    [
      "empty instructions",
      { name: "x", questions: { a: { type: "boolean", instructions: "" } } },
      /"instructions" must be a non-empty string/,
    ],
    [
      "an unknown question field",
      { name: "x", questions: { a: { type: "boolean", instructions: "A?", options: ["x", "y"] } } },
      /unknown field "options" for a boolean question/,
    ],
    [
      "choice without options",
      { name: "x", questions: { a: { type: "choice", instructions: "A?" } } },
      /choice needs an "options" list/,
    ],
    [
      "score without max",
      { name: "x", questions: { a: { type: "score", instructions: "A?", min: 0 } } },
      /score needs "max"/,
    ],
    [
      "score with a string min",
      { name: "x", questions: { a: { type: "score", instructions: "A?", min: "0", max: 1 } } },
      /"min" must be a number/,
    ],
    [
      "score with min greater than max",
      { name: "x", questions: { a: { type: "score", instructions: "A?", min: 10, max: 1 } } },
      /"min" \(10\) must be less than "max" \(1\)/,
    ],
    [
      "a non-boolean integer flag",
      { name: "x", questions: { a: { type: "score", instructions: "A?", min: 0, max: 1, integer: "yes" } } },
      /"integer" must be true or false/,
    ],
    [
      "integer scores with fractional bounds",
      { name: "x", questions: { a: { type: "score", instructions: "A?", min: 0.5, max: 3, integer: true } } },
      /must be whole numbers/,
    ],
    [
      "a key starting with a digit",
      { name: "x", questions: { "1st": { type: "boolean", instructions: "A?" } } },
      /question "1st": bad key name/,
    ],
  ];

  for (const [label, input, message] of bad) {
    it(`rejects ${label}`, () => {
      expect(() => validateQuestionSet(input, "label")).toThrow(QuestionSetError);
      expect(() => validateQuestionSet(input, "label")).toThrow(message);
    });
  }
});

describe("parseQuestionSet", () => {
  it("reports duplicate top-level keys", () => {
    expect(() => parseQuestionSet("name: a\nname: b\nquestions: {}\n", "x.yaml")).toThrow(
      /x\.yaml: duplicate key "name" \(line 2\)/,
    );
  });
});

describe("error messages show non-finite numbers as written", () => {
  it("says Infinity for a YAML .inf, not null", () => {
    const yaml = "name: s\nquestions:\n  stars:\n    type: score\n    instructions: Rate it.\n    min: 1\n    max: .inf\n";
    expect(() => parseQuestionSet(yaml, "s.yaml")).toThrow('s.yaml: question "stars": "max" must be a number, got number Infinity');
  });

  it("says -Infinity and NaN too", () => {
    const set = (min: number) => ({ name: "s", questions: { stars: { type: "score", instructions: "Rate it.", min, max: 5 } } });
    expect(() => validateQuestionSet(set(Number.NEGATIVE_INFINITY), "x")).toThrow("got number -Infinity");
    expect(() => validateQuestionSet(set(Number.NaN), "x")).toThrow("got number NaN");
  });

  it("says NaN for a non-finite choice option", () => {
    const set = { name: "s", questions: { pick: { type: "choice", instructions: "Pick.", options: ["a", Number.NaN] } } };
    expect(() => validateQuestionSet(set, "x")).toThrow('question "pick": option 2 must be a non-empty string, got number NaN');
  });
});
