/**
 * QA (Ibn Rushd) integration tests for `decidekit test`: drives main() end to
 * end with fake providers and hand-computed expected numbers. No network.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { main } from "../src/cli.js";
import type { CliDeps } from "../src/cli.js";
import type { Provider, ProviderRequest } from "../src/index.js";

const SET = "examples/support-triage.yaml";
const SHIPPED = "examples/support-triage.examples.yaml";
const TEAMS = ["Billing", "Technical", "Sales", "Account"];

type Expected = Record<string, boolean | string | number>;
interface Ex {
  id?: string | number;
  input: string;
  expected: Expected;
}

/** Turns a plain answer map into the provider JSON shape decide() parses. */
function toJson(answers: Record<string, unknown>): Record<string, unknown> {
  const json: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (key === "team" && typeof value === "string" && TEAMS.includes(value)) {
      json[key] = { value, scores: Object.fromEntries(TEAMS.map((t) => [t, t === value ? 0.7 : 0.1])) };
    } else {
      json[key] = { value, confidence: 0.8 };
    }
  }
  return json;
}

/** A provider that finds which example's input is in the prompt and answers via `answer`. */
function oracle(examples: Ex[], answer: (ex: Ex) => Record<string, unknown>, calls: string[] = []): Provider {
  return {
    name: "fake",
    model: "fake-1",
    async complete(request: ProviderRequest) {
      const ex = examples.find((e) => request.prompt.includes(e.input.trim()));
      if (ex === undefined) throw new Error("fake provider: unknown example");
      calls.push(String(ex.id));
      return { json: toJson(answer(ex)) };
    },
  };
}

function harness(provider: Provider | (() => Provider), extra: Partial<CliDeps> = {}) {
  const out = { stdout: "", stderr: "", created: 0 };
  const deps: Partial<CliDeps> = {
    stdout: (t) => {
      out.stdout += t;
    },
    stderr: (t) => {
      out.stderr += t;
    },
    env: {},
    createProvider: () => {
      out.created++;
      return typeof provider === "function" ? provider() : provider;
    },
    ...extra,
  };
  return { out, deps };
}

let shipped: Ex[] = [];
let dir = "";

beforeAll(async () => {
  shipped = (parse(await readFile(SHIPPED, "utf8")) as { examples: Ex[] }).examples;
  dir = await mkdtemp(join(tmpdir(), "decidekit-qa-"));
});
afterAll(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true });
});

describe("QA: shipped support-triage examples", () => {
  it("has at least 8 examples, each fully labelled, covering every team, both urgency values and refund values", () => {
    expect(shipped.length).toBeGreaterThanOrEqual(8);
    for (const ex of shipped) expect(Object.keys(ex.expected).sort()).toEqual(["frustration", "refund_requested", "team", "urgent"]);
    expect(new Set(shipped.map((e) => e.expected.team))).toEqual(new Set(TEAMS));
    expect(new Set(shipped.map((e) => e.expected.urgent))).toEqual(new Set([true, false]));
    expect(new Set(shipped.map((e) => e.expected.refund_requested))).toEqual(new Set([true, false]));
    expect(new Set(shipped.map((e) => e.id)).size).toBe(shipped.length);
  });

  it("a provider that answers exactly the labels scores 100% on every question", async () => {
    const calls: string[] = [];
    const h = harness(oracle(shipped, (ex) => ex.expected, calls));
    expect(await main(["test", SET, SHIPPED], h.deps)).toBe(0);
    const n = shipped.length;
    expect(h.out.stdout).toMatch(new RegExp(`^urgent\\s+${n}/${n}\\s+100\\.0%$`, "m"));
    expect(h.out.stdout).toMatch(new RegExp(`^overall\\s+${n * 4}/${n * 4}\\s+100\\.0%$`, "m"));
    expect(h.out.stdout).toContain("No wrong answers.");
    expect(calls).toEqual(shipped.map((e) => String(e.id))); // one call per example, in order
  });

  it("perturbing frustration by 1 on every example and flipping urgent on two: hand-computed numbers, tolerance 0 and 1", async () => {
    const n = shipped.length; // 12
    const flipped = new Set([String(shipped[0]?.id), String(shipped[1]?.id)]);
    const answer = (ex: Ex) => ({
      ...ex.expected,
      urgent: flipped.has(String(ex.id)) ? !ex.expected.urgent : ex.expected.urgent,
      // stay within 1..5
      frustration: (ex.expected.frustration as number) === 5 ? 4 : (ex.expected.frustration as number) + 1,
    });
    const t0 = harness(oracle(shipped, answer));
    expect(await main(["test", SET, SHIPPED, "--json"], t0.deps)).toBe(0);
    const r0 = JSON.parse(t0.out.stdout);
    expect(r0.questions.urgent).toEqual({ correct: n - 2, total: n, accuracy: (n - 2) / n });
    expect(r0.questions.frustration).toEqual({ correct: 0, total: n, accuracy: 0 });
    expect(r0.overall.correct).toBe(n * 4 - 2 - n);
    expect(r0.overall.total).toBe(n * 4);
    expect(r0.wrong).toHaveLength(n + 2);
    // Order: by example, then question-set order (urgent before frustration).
    expect(r0.wrong[0]).toMatchObject({ example: String(shipped[0]?.id), question: "urgent" });
    expect(r0.wrong[1]).toMatchObject({ example: String(shipped[0]?.id), question: "frustration" });

    const t1 = harness(oracle(shipped, answer));
    expect(await main(["test", SET, SHIPPED, "--tolerance", "1"], t1.deps)).toBe(0);
    expect(t1.out.stdout).toMatch(new RegExp(`^frustration\\s+${n}/${n}\\s+100\\.0%$`, "m"));
    // 46/48 = 95.8%
    expect(t1.out.stdout).toMatch(new RegExp(`^overall\\s+${n * 4 - 2}/${n * 4}\\s+95\\.8%$`, "m"));
    expect(t1.out.stdout).toContain("Wrong answers (2):");
  });
});

describe("QA: tolerance on a non-integer score and unlabelled questions", () => {
  let setPath = "";
  let exPath = "";
  const examples: Ex[] = [
    { id: 1, input: "ALPHA text", expected: { level: 2.5 } },
    { id: 2, input: "BETA text", expected: { level: 7, ok: true } },
    { id: 3, input: "GAMMA text", expected: { level: 0 } },
  ];
  // model: ALPHA 3.0 (off 0.5), BETA 6.6 (off 0.4) and ok false, GAMMA 2 (off 2)
  const answers: Record<string, Record<string, unknown>> = {
    "1": { level: 3, ok: true, unused: "a" },
    "2": { level: 6.6, ok: false, unused: "a" },
    "3": { level: 2, ok: true, unused: "b" },
  };

  beforeAll(async () => {
    setPath = join(dir, "levels.yaml");
    exPath = join(dir, "levels.examples.yaml");
    await writeFile(
      setPath,
      [
        "name: levels",
        "version: 1",
        "questions:",
        "  level: {type: score, instructions: How much, min: 0, max: 10}",
        "  ok: {type: boolean, instructions: Is it ok}",
        "  unused: {type: choice, instructions: Pick, options: [a, b]}",
        "",
      ].join("\n"),
    );
    await writeFile(
      exPath,
      "examples:\n" +
        examples
          .map((e) => `  - id: ${e.id}\n    input: ${e.input}\n    expected: ${JSON.stringify(e.expected)}\n`)
          .join(""),
    );
  });

  const run = async (extra: string[]) => {
    const h = harness(oracle(examples, (ex) => answers[String(ex.id)] ?? {}));
    const code = await main(["test", setPath, exPath, ...extra], h.deps);
    return { code, ...h.out };
  };

  it("default tolerance 0: no score within range; unlabelled question shows no labels / null", async () => {
    const r = await run(["--json"]);
    expect(r.code).toBe(0);
    const rep = JSON.parse(r.stdout);
    expect(rep.tolerance).toBe(0);
    expect(rep.questions.level).toEqual({ correct: 0, total: 3, accuracy: 0 });
    expect(rep.questions.ok).toEqual({ correct: 0, total: 1, accuracy: 0 });
    expect(rep.questions.unused).toEqual({ correct: 0, total: 0, accuracy: null });
    expect(rep.overall).toEqual({ correct: 0, total: 4, accuracy: 0 });
    const text = await run([]);
    expect(text.stdout).toMatch(/^unused\s+0\/0\s+no labels$/m);
    expect(text.stdout).toMatch(/^overall\s+0\/4\s+0\.0%$/m);
    expect(text.stdout).toMatch(/^\s+1\s+level\s+expected 2\.5\s+got 3$/m);
  });

  it("tolerance 0.4 accepts the 0.4 miss (float-safe), 0.5 accepts both, 2 accepts all", async () => {
    const a = JSON.parse((await run(["--json", "--tolerance", "0.4"])).stdout);
    expect(a.questions.level.correct).toBe(1);
    const b = JSON.parse((await run(["--json", "--tolerance", "0.5"])).stdout);
    expect(b.questions.level.correct).toBe(2);
    const c = JSON.parse((await run(["--json", "--tolerance", "2"])).stdout);
    expect(c.questions.level).toEqual({ correct: 3, total: 3, accuracy: 1 });
    expect(c.overall).toEqual({ correct: 3, total: 4, accuracy: 0.75 });
  });

  it("--min-accuracy at exactly the overall accuracy passes; just above fails", async () => {
    expect((await run(["--tolerance", "2", "--min-accuracy", "75"])).code).toBe(0);
    const r = await run(["--tolerance", "2", "--min-accuracy", "75.1"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("75.0% is below --min-accuracy 75.1%");
  });

  it("an answer the provider leaves out counts as wrong (FAILED)", async () => {
    const h = harness(oracle(examples, (ex) => (ex.id === 2 ? { level: 7, unused: "a" } : (answers[String(ex.id)] ?? {}))));
    expect(await main(["test", setPath, exPath, "--json"], h.deps)).toBe(0);
    const rep = JSON.parse(h.out.stdout);
    expect(rep.questions.ok).toEqual({ correct: 0, total: 1, accuracy: 0 });
    const miss = rep.wrong.find((w: { question: string }) => w.question === "ok");
    expect(miss).toMatchObject({ example: "2", question: "ok", expected: true });
    expect(typeof miss.error).toBe("string");
  });
});

describe("QA: validation happens before the provider is created", () => {
  const missingKey = () => {
    throw new Error("anthropic: no API key; set the ANTHROPIC_API_KEY environment variable");
  };

  it("valid files with a provider that cannot be created: exit 1 with the provider error, no report", async () => {
    const h = harness(missingKey);
    expect(await main(["test", SET, SHIPPED], h.deps)).toBe(1);
    expect(h.out.stderr).toMatch(/no API key/);
    expect(h.out.stdout).toBe("");
  });

  for (const [label, yamlText, message] of [
    ["empty file", "", /must be a mapping with an "examples" list/],
    ["unknown key", "examples:\n  - input: x\n    expected: {priority: high}\n", /expected "priority": no such question/],
    ["out of range", "examples:\n  - input: x\n    expected: {frustration: 0}\n", /0 is outside the range 1 to 5/],
    ["duplicate numeric id", "examples:\n  - {id: 7, input: a, expected: {urgent: true}}\n  - {id: 7, input: b, expected: {urgent: true}}\n", /example "7": duplicate id/],
    ["bad option", "examples:\n  - input: x\n    expected: {team: billing}\n", /"billing" is not one of the options/],
  ] as const) {
    it(`${label}: examples error wins over the missing-key error`, async () => {
      const h = harness(missingKey, { readFile: async () => yamlText });
      expect(await main(["test", SET, "x.examples.yaml"], h.deps)).toBe(1);
      expect(h.out.stderr).toMatch(message);
      expect(h.out.stderr).toMatch(/^decidekit test: x\.examples\.yaml: /);
      expect(h.out.created).toBe(0);
    });
  }
});
