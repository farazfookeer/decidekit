// QA integration tests for R-1 (question set format and loader).
// Exercises loadQuestionSet end to end through the public entry point, using
// YAML files written to a temporary directory. No network.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QuestionSetError, loadQuestionSet } from "../src/index.js";
import type { QuestionSet } from "../src/index.js";

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "decidekit-qa-"));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function writeSet(name: string, text: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, text, "utf8");
  return path;
}

async function loadErr(name: string, text: string): Promise<{ path: string; error: QuestionSetError }> {
  const path = await writeSet(name, text);
  try {
    await loadQuestionSet(path);
  } catch (error) {
    expect(error).toBeInstanceOf(QuestionSetError);
    return { path, error: error as QuestionSetError };
  }
  throw new Error(`expected ${name} to fail`);
}

describe("QA: valid files through the public API", () => {
  it("loads all three types, integer optional, and preserves declared order", async () => {
    const path = await writeSet(
      "all.yaml",
      [
        "name: all",
        "questions:",
        "  urgent: {type: boolean, instructions: Urgent?}",
        "  team: {type: choice, instructions: Team?, options: [A, B]}",
        "  stars: {type: score, instructions: Stars?, min: -5, max: 5, integer: true}",
        "  ratio: {type: score, instructions: Ratio?, min: 0.1, max: 0.9}",
        "  frac: {type: score, instructions: Frac?, min: 0.1, max: 0.9, integer: false}",
        "",
      ].join("\n"),
    );
    const set: QuestionSet = await loadQuestionSet(path);
    expect(Object.keys(set.questions)).toEqual(["urgent", "team", "stars", "ratio", "frac"]);
    expect(set.questions["stars"]).toEqual({ type: "score", instructions: "Stars?", min: -5, max: 5, integer: true });
    expect(set.questions["ratio"]).toEqual({ type: "score", instructions: "Ratio?", min: 0.1, max: 0.9 });
    expect(set.questions["frac"]).toMatchObject({ integer: false });
  });

  it("accepts YAML aliases and a question key named like an Object method", async () => {
    const path = await writeSet(
      "alias.yaml",
      "name: x\nquestions:\n  a: &q {type: boolean, instructions: A?}\n  constructor: *q\n",
    );
    const set = await loadQuestionSet(path);
    expect(set.questions["constructor"]).toEqual({ type: "boolean", instructions: "A?" });
  });
});

describe("QA: invalid files name the file and the offending question/field", () => {
  const cases: Array<{ name: string; text: string; question?: string; field?: string; message: RegExp }> = [
    { name: "empty.yaml", text: "", message: /must be a mapping, got null/ },
    { name: "comments.yaml", text: "# nothing here\n", message: /must be a mapping/ },
    { name: "top-list.yaml", text: "- a\n- b\n", message: /must be a mapping, got a list/ },
    {
      name: "questions-list.yaml",
      text: "name: x\nquestions:\n  - type: boolean\n    instructions: A?\n",
      field: "questions",
      message: /"questions" must be a mapping/,
    },
    {
      name: "num-options.yaml",
      text: "name: x\nquestions:\n  a: {type: choice, instructions: A?, options: [1, 2]}\n",
      question: "a",
      field: "options",
      message: /option 1 must be a non-empty string, got number 1/,
    },
    {
      name: "dup-options.yaml",
      text: "name: x\nquestions:\n  a: {type: choice, instructions: A?, options: [A, A]}\n",
      question: "a",
      field: "options",
      message: /duplicate option "A"/,
    },
    {
      name: "options-scalar.yaml",
      text: "name: x\nquestions:\n  a: {type: choice, instructions: A?, options: A}\n",
      question: "a",
      field: "options",
      message: /"options" must be a list/,
    },
    {
      name: "zero-options.yaml",
      text: "name: x\nquestions:\n  a: {type: choice, instructions: A?, options: []}\n",
      question: "a",
      field: "options",
      message: /at least 2 options/,
    },
    {
      name: "null-option.yaml",
      text: "name: x\nquestions:\n  a: {type: choice, instructions: A?, options: [A, ~]}\n",
      question: "a",
      field: "options",
      message: /option 2 must be a non-empty string/,
    },
    {
      name: "word-min.yaml",
      text: "name: x\nquestions:\n  a: {type: score, instructions: A?, min: low, max: 5}\n",
      question: "a",
      field: "min",
      message: /"min" must be a number/,
    },
    {
      name: "inf-max.yaml",
      text: "name: x\nquestions:\n  a: {type: score, instructions: A?, min: 0, max: .inf}\n",
      question: "a",
      field: "max",
      message: /"max" must be a number/,
    },
    {
      name: "min-gt-max.yaml",
      text: "name: x\nquestions:\n  a: {type: score, instructions: A?, min: 9, max: 1}\n",
      question: "a",
      field: "min",
      message: /"min" \(9\) must be less than "max" \(1\)/,
    },
    {
      name: "integer-string.yaml",
      text: "name: x\nquestions:\n  a: {type: score, instructions: A?, min: 0, max: 1, integer: 'true'}\n",
      question: "a",
      field: "integer",
      message: /"integer" must be true or false/,
    },
    {
      name: "type-case.yaml",
      text: "name: x\nquestions:\n  a: {type: Boolean, instructions: A?}\n",
      question: "a",
      field: "type",
      message: /unknown type "Boolean"/,
    },
    {
      name: "null-question.yaml",
      text: "name: x\nquestions:\n  a:\n",
      question: "a",
      message: /must be a mapping/,
    },
    {
      name: "numeric-instructions.yaml",
      text: "name: x\nquestions:\n  a: {type: boolean, instructions: 42}\n",
      question: "a",
      field: "instructions",
      message: /"instructions" must be a non-empty string/,
    },
    {
      name: "proto-key.yaml",
      text: "name: x\nquestions:\n  a: {type: boolean, instructions: A?}\n  __proto__: {type: boolean, instructions: B?}\n",
      question: "__proto__",
      message: /bad key name/,
    },
    {
      name: "numeric-key.yaml",
      text: "name: x\nquestions:\n  1: {type: boolean, instructions: A?}\n",
      question: "1",
      message: /bad key name/,
    },
    {
      name: "dup-quoted-key.yaml",
      text: "name: x\nquestions:\n  a1: {type: boolean, instructions: A?}\n  'a1': {type: boolean, instructions: B?}\n",
      question: "a1",
      message: /defined more than once \(line 4\)/,
    },
    {
      name: "dup-type-field.yaml",
      text: "name: x\nquestions:\n  a: {type: choice, instructions: A?, options: [A, B], type: boolean}\n",
      question: "a",
      field: "type",
      message: /duplicate key "type"/,
    },
    {
      name: "multi-doc.yaml",
      text: "name: x\nquestions:\n  a: {type: boolean, instructions: A?}\n---\nname: y\n",
      message: /invalid YAML/,
    },
  ];

  for (const { name, text, question, field, message } of cases) {
    it(name, async () => {
      const { path, error } = await loadErr(name, text);
      expect(error.message.startsWith(`${path}: `)).toBe(true);
      expect(error.message).toMatch(message);
      expect(error.source).toBe(path);
      expect(error.question).toBe(question);
      expect(error.field).toBe(field);
    });
  }

  it("reports a directory path as unreadable, naming it", async () => {
    await expect(loadQuestionSet(dir)).rejects.toThrow(`${dir}: cannot read file`);
  });
});
