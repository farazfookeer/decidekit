import { describe, expect, it } from "vitest";
import {
  ExamplesError,
  ProviderError,
  isCorrect,
  loadExamples,
  loadQuestionSet,
  measureAccuracy,
  parseExamples,
  validateExamples,
} from "../src/index.js";
import type { LabelledExample, QuestionSet } from "../src/index.js";
import { createFakeProvider } from "./helpers/fakeProvider.js";

const SET: QuestionSet = {
  name: "mini",
  questions: {
    urgent: { type: "boolean", instructions: "Is it urgent?" },
    team: { type: "choice", instructions: "Which team?", options: ["Billing", "Technical"] },
    mood: { type: "score", instructions: "How cross?", min: 1, max: 5, integer: true },
    ratio: { type: "score", instructions: "A fraction.", min: 0, max: 1 },
  },
};

function bad(obj: unknown, message: string | RegExp): void {
  expect(() => validateExamples(obj, SET, "f.yaml")).toThrow(ExamplesError);
  expect(() => validateExamples(obj, SET, "f.yaml")).toThrow(message);
}

const one = (example: Record<string, unknown>) => ({ examples: [example] });

describe("validateExamples", () => {
  it("accepts a valid file, defaulting ids to #<n> and allowing partial labels", () => {
    const examples = validateExamples(
      {
        description: "d",
        examples: [
          { id: "a", input: "text a", expected: { urgent: true, team: "Billing", mood: 3, ratio: 0.5 } },
          { input: "text b", expected: { team: "Technical" } },
          { id: 7, input: "text c", expected: { urgent: false } },
        ],
      },
      SET,
      "f.yaml",
    );
    expect(examples).toEqual([
      { id: "a", input: "text a", expected: { urgent: true, team: "Billing", mood: 3, ratio: 0.5 } },
      { id: "#2", input: "text b", expected: { team: "Technical" } },
      { id: "7", input: "text c", expected: { urgent: false } },
    ]);
  });

  it("rejects bad file shapes", () => {
    bad(null, "f.yaml: a labelled examples file must be a mapping");
    bad({}, 'f.yaml: no examples: add an "examples" list');
    bad({ examples: {} }, '"examples" must be a list, got a mapping');
    bad({ examples: [] }, '"examples" is empty');
    bad({ examples: [], extra: 1 }, 'unknown top-level field "extra"');
    bad({ description: 3, examples: [] }, '"description" must be a string');
  });

  it("rejects bad examples, naming the example", () => {
    bad({ examples: ["hi"] }, 'f.yaml: example "#1": must be a mapping');
    bad(one({ expected: { urgent: true } }), 'f.yaml: example "#1": missing "input"');
    bad(one({ input: "  ", expected: { urgent: true } }), '"input" must be a non-empty string');
    bad(one({ id: "x", input: "t" }), 'f.yaml: example "x": missing "expected"');
    bad(one({ input: "t", expected: [] }), '"expected" must be a mapping');
    bad(one({ input: "t", expected: {} }), '"expected" is empty');
    bad(one({ input: "t", expected: { urgent: true }, notes: "x" }), 'unknown field "notes"');
    bad(one({ id: true, input: "t", expected: { urgent: true } }), '"id" must be a non-empty string or number');
    bad(
      { examples: [{ id: "d", input: "t", expected: { urgent: true } }, { id: "d", input: "u", expected: { urgent: true } }] },
      'example "d": duplicate id',
    );
  });

  it("rejects bad expected values, naming the example and key", () => {
    bad(
      one({ id: "e", input: "t", expected: { priority: 1 } }),
      'f.yaml: example "e": expected "priority": no such question in set "mini" (questions: urgent, team, mood, ratio)',
    );
    bad(one({ input: "t", expected: { urgent: "yes" } }), 'expected "urgent": must be true or false, got string "yes"');
    bad(one({ input: "t", expected: { team: "billing" } }), 'expected "team": "billing" is not one of the options (Billing, Technical)');
    bad(one({ input: "t", expected: { team: 3 } }), 'expected "team": number 3 is not one of the options');
    bad(one({ input: "t", expected: { mood: 6 } }), 'expected "mood": 6 is outside the range 1 to 5');
    bad(one({ input: "t", expected: { mood: 2.5 } }), 'expected "mood": must be a whole number, got 2.5');
    bad(one({ input: "t", expected: { mood: "4" } }), 'expected "mood": must be a number, got string "4"');
  });

  it("names Infinity and NaN instead of printing null", () => {
    const yaml = (key: string, value: string) => `examples:\n  - input: t\n    expected:\n      ${key}: ${value}\n`;
    const cases: [string, string, string][] = [
      ["mood", ".inf", 'expected "mood": must be a number, got number Infinity'],
      ["mood", "-.inf", 'expected "mood": must be a number, got number -Infinity'],
      ["ratio", ".nan", 'expected "ratio": must be a number, got number NaN'],
      ["urgent", ".inf", 'expected "urgent": must be true or false, got number Infinity'],
      ["urgent", ".nan", 'expected "urgent": must be true or false, got number NaN'],
      ["team", ".inf", 'expected "team": number Infinity is not one of the options (Billing, Technical)'],
      ["team", ".nan", 'expected "team": number NaN is not one of the options (Billing, Technical)'],
    ];
    for (const [key, value, message] of cases) {
      expect(() => parseExamples(yaml(key, value), SET, "f.yaml")).toThrow(message);
      expect(() => parseExamples(yaml(key, value), SET, "f.yaml")).not.toThrow(/null/);
    }
  });
});

describe("parseExamples / loadExamples", () => {
  it("parses YAML and reports YAML errors with a line number", () => {
    const text = "examples:\n  - input: hello\n    expected:\n      urgent: true\n";
    expect(parseExamples(text, SET, "x.yaml")).toEqual([{ id: "#1", input: "hello", expected: { urgent: true } }]);
    expect(() => parseExamples("examples: [\n", SET, "x.yaml")).toThrow(/^x\.yaml: invalid YAML at line \d+/);
    expect(() => parseExamples("examples: []\nexamples: []\n", SET, "x.yaml")).toThrow(/x\.yaml: invalid YAML/);
  });

  it("loadExamples names a missing file", async () => {
    await expect(loadExamples("missing.examples.yaml", SET)).rejects.toThrow(/^missing\.examples\.yaml: cannot read file/);
  });

  it("the shipped support-triage examples are valid, varied and fully labelled", async () => {
    const set = await loadQuestionSet("examples/support-triage.yaml");
    const examples = await loadExamples("examples/support-triage.examples.yaml", set);
    expect(examples.length).toBeGreaterThanOrEqual(8);
    const teams = new Set(examples.map((e) => e.expected.team));
    expect([...teams].sort()).toEqual(["Account", "Billing", "Sales", "Technical"]);
    const moods = examples.map((e) => e.expected.frustration as number);
    expect(Math.min(...moods)).toBe(1);
    expect(Math.max(...moods)).toBeGreaterThanOrEqual(4);
    expect(new Set(examples.map((e) => e.expected.urgent))).toEqual(new Set([true, false]));
    expect(new Set(examples.map((e) => e.expected.refund_requested))).toEqual(new Set([true, false]));
    for (const e of examples) expect(Object.keys(e.expected).sort()).toEqual(Object.keys(set.questions).sort());
    expect(new Set(examples.map((e) => e.id)).size).toBe(examples.length);
  });
});

describe("isCorrect", () => {
  const q = SET.questions;
  it("compares booleans and choices exactly", () => {
    expect(isCorrect(q.urgent!, true, { ok: true, value: true })).toBe(true);
    expect(isCorrect(q.urgent!, true, { ok: true, value: false })).toBe(false);
    expect(isCorrect(q.team!, "Billing", { ok: true, value: "Billing" }, 5)).toBe(true);
    expect(isCorrect(q.team!, "Billing", { ok: true, value: "Technical" }, 5)).toBe(false);
  });

  it("scores within the tolerance (default 0)", () => {
    expect(isCorrect(q.mood!, 4, { ok: true, value: 4 })).toBe(true);
    expect(isCorrect(q.mood!, 4, { ok: true, value: 3 })).toBe(false);
    expect(isCorrect(q.mood!, 4, { ok: true, value: 3 }, 1)).toBe(true);
    expect(isCorrect(q.mood!, 4, { ok: true, value: 2 }, 1)).toBe(false);
    expect(isCorrect(q.ratio!, 0.3, { ok: true, value: 0.4 }, 0.1)).toBe(true);
  });

  it("a failed answer is always wrong", () => {
    expect(isCorrect(q.urgent!, true, { ok: false, error: "bad" })).toBe(false);
    expect(isCorrect(q.mood!, 4, { ok: false, error: "bad" }, 10)).toBe(false);
  });
});

describe("measureAccuracy", () => {
  const examples: LabelledExample[] = [
    { id: "a", input: "one", expected: { urgent: true, mood: 4 } },
    { id: "b", input: "two", expected: { team: "Technical" } },
  ];
  const answers = (urgent: boolean, team: string, mood: number) => ({
    urgent: { value: urgent, confidence: 0.8 },
    team: { value: team, scores: { Billing: 0.5, Technical: 0.5 } },
    mood: { value: mood },
    ratio: { value: 0.5 },
  });

  it("counts per question and overall, skipping unlabelled questions", async () => {
    const provider = createFakeProvider([answers(true, "Billing", 2), answers(false, "Billing", 1)]);
    const report = await measureAccuracy({ provider, set: SET, examples, tolerance: 1 });
    expect(report.questions).toEqual({
      urgent: { correct: 1, total: 1, accuracy: 1 },
      team: { correct: 0, total: 1, accuracy: 0 },
      mood: { correct: 0, total: 1, accuracy: 0 },
      ratio: { correct: 0, total: 0, accuracy: null },
    });
    expect(report.overall).toEqual({ correct: 1, total: 3, accuracy: 1 / 3 });
    expect(report.wrong).toEqual([
      { example: "a", question: "mood", expected: 4, got: 2 },
      { example: "b", question: "team", expected: "Technical", got: "Billing" },
    ]);
    expect(report).toMatchObject({ set: "mini", provider: "fake", model: "fake-model", tolerance: 1, examples: 2 });
  });

  it("rethrows provider errors with the example id, keeping the ProviderError type", async () => {
    const provider = createFakeProvider([answers(true, "Billing", 4), new ProviderError("boom", { status: 500 })]);
    const run = measureAccuracy({ provider, set: SET, examples });
    await expect(run).rejects.toThrow(ProviderError);
    await expect(
      measureAccuracy({ provider: createFakeProvider([new ProviderError("boom", { status: 500 })]), set: SET, examples }),
    ).rejects.toThrow('example "a": boom');
  });

  it("rejects a negative tolerance", async () => {
    await expect(measureAccuracy({ provider: createFakeProvider([]), set: SET, examples, tolerance: -1 })).rejects.toThrow(
      /tolerance/,
    );
  });
});
