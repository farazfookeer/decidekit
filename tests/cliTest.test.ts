import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import type { CliDeps, CreateProviderOptions, ProviderName } from "../src/cli.js";
import { ProviderError } from "../src/index.js";
import type { Provider, ProviderRequest } from "../src/index.js";

const SET = "examples/support-triage.yaml";
const FIXTURE = "tests/fixtures/examples/triage.examples.yaml";
const SHIPPED = "examples/support-triage.examples.yaml";

const TEAMS = ["Billing", "Technical", "Sales", "Account"];
const bool = (value: unknown) => ({ value, confidence: 0.9 });
const team = (value: string) => ({
  value,
  scores: Object.fromEntries(TEAMS.map((t) => [t, t === value ? 0.7 : 0.1])),
});

/**
 * Known answers per fixture marker. Against the fixture's labels:
 * - A: all right except frustration 3 (expected 4; right with tolerance 1)
 * - B: urgent wrong (true vs false); team and frustration right
 * - C: team wrong (Account vs Technical); frustration 2 vs 5 wrong at any tolerance below 3
 * - D: urgent is never valid (FAILED, counts as wrong); refund_requested right
 *
 * Tolerance 0: urgent 1/3, team 2/3, refund_requested 2/2, frustration 1/3, overall 6/11.
 * Tolerance 1: frustration 2/3, overall 7/11.
 */
const ANSWERS: Record<string, Record<string, unknown>> = {
  "MARKER-A": { urgent: bool(true), team: team("Billing"), refund_requested: bool(true), frustration: { value: 3 } },
  "MARKER-B": { urgent: bool(true), team: team("Sales"), refund_requested: bool(false), frustration: { value: 1 } },
  "MARKER-C": { urgent: bool(true), team: team("Account"), refund_requested: bool(false), frustration: { value: 2 } },
  "MARKER-D": { urgent: bool("maybe"), team: team("Account"), refund_requested: bool(false), frustration: { value: 2 } },
};

function markerProvider(name: string, model: string, calls: string[]): Provider {
  return {
    name,
    model,
    async complete(request: ProviderRequest) {
      const marker = Object.keys(ANSWERS).find((m) => request.prompt.includes(m));
      if (marker === undefined) throw new Error("fake provider: no marker in prompt");
      calls.push(marker);
      return { json: ANSWERS[marker] };
    },
  };
}

function harness(extra: Partial<CliDeps> = {}) {
  const out = { stdout: "", stderr: "" };
  const calls: string[] = [];
  const created: { name: ProviderName; options: CreateProviderOptions }[] = [];
  const deps: Partial<CliDeps> = {
    stdout: (t) => {
      out.stdout += t;
    },
    stderr: (t) => {
      out.stderr += t;
    },
    env: {},
    createProvider: (name, options) => {
      created.push({ name, options });
      return markerProvider(name, options.model ?? "default-model", calls);
    },
    ...extra,
  };
  return { out, calls, created, deps };
}

describe("decidekit test: accuracy numbers", () => {
  it("reports per-question and overall accuracy and the wrong answers (tolerance 0)", async () => {
    const h = harness();
    expect(await main(["test", SET, FIXTURE], h.deps)).toBe(0);
    expect(h.out.stderr).toBe("");
    const out = h.out.stdout;
    expect(out).toContain("support-triage: 4 examples · provider anthropic · model default-model · score tolerance 0");
    expect(out).toMatch(/^urgent\s+1\/3\s+33\.3%$/m);
    expect(out).toMatch(/^team\s+2\/3\s+66\.7%$/m);
    expect(out).toMatch(/^refund_requested\s+2\/2\s+100\.0%$/m);
    expect(out).toMatch(/^frustration\s+1\/3\s+33\.3%$/m);
    expect(out).toMatch(/^overall\s+6\/11\s+54\.5%$/m);
    expect(out).toContain("Wrong answers (5):");
    expect(out).toMatch(/^\s+case-a\s+frustration\s+expected 4\s+got 3$/m);
    expect(out).toMatch(/^\s+case-b\s+urgent\s+expected false\s+got true$/m);
    expect(out).toMatch(/^\s+case-c\s+team\s+expected Technical\s+got Account$/m);
    expect(out).toMatch(/^\s+case-c\s+frustration\s+expected 5\s+got 2$/m);
    expect(out).toMatch(/^\s+#4\s+urgent\s+expected true\s+got FAILED \(.*true or false.*\(after retry\)\)$/m);
    // One call per example, plus one retry for the FAILED answer of #4.
    expect(h.calls).toEqual(["MARKER-A", "MARKER-B", "MARKER-C", "MARKER-D", "MARKER-D"]);
  });

  it("--tolerance 1 counts near-miss scores as correct", async () => {
    const h = harness();
    expect(await main(["test", SET, FIXTURE, "--tolerance", "1"], h.deps)).toBe(0);
    expect(h.out.stdout).toContain("score tolerance 1");
    expect(h.out.stdout).toMatch(/^frustration\s+2\/3\s+66\.7%$/m);
    expect(h.out.stdout).toMatch(/^overall\s+7\/11\s+63\.6%$/m);
    expect(h.out.stdout).toContain("Wrong answers (4):");
    expect(h.out.stdout).not.toMatch(/case-a\s+frustration/);
  });

  it("--json prints a machine-readable report with the same numbers", async () => {
    const h = harness();
    expect(await main(["test", SET, FIXTURE, "--json", "--provider", "ollama", "--model", "m1"], h.deps)).toBe(0);
    const report = JSON.parse(h.out.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      set: "support-triage",
      provider: "ollama",
      model: "m1",
      tolerance: 0,
      examples: 4,
      questions: {
        urgent: { correct: 1, total: 3 },
        team: { correct: 2, total: 3 },
        refund_requested: { correct: 2, total: 2, accuracy: 1 },
        frustration: { correct: 1, total: 3 },
      },
      overall: { correct: 6, total: 11 },
    });
    expect((report.overall as { accuracy: number }).accuracy).toBeCloseTo(6 / 11);
    const wrong = report.wrong as Record<string, unknown>[];
    expect(wrong).toHaveLength(5);
    expect(wrong[0]).toEqual({ example: "case-a", question: "frustration", expected: 4, got: 3 });
    expect(wrong[4]).toMatchObject({ example: "#4", question: "urgent", expected: true });
    expect(wrong[4]?.error).toMatch(/true or false/);
    expect(h.created).toEqual([{ name: "ollama", options: { model: "m1" } }]);
  });

  it("--min-accuracy exits 1 below the threshold and 0 at or above it", async () => {
    const below = harness();
    expect(await main(["test", SET, FIXTURE, "--min-accuracy", "60"], below.deps)).toBe(1);
    expect(below.out.stdout).toContain("overall"); // the report is still printed
    expect(below.out.stderr).toBe("decidekit test: overall accuracy 54.5% is below --min-accuracy 60%\n");

    const above = harness();
    expect(await main(["test", SET, FIXTURE, "--min-accuracy", "54"], above.deps)).toBe(0);
    expect(above.out.stderr).toBe("");
  });

  it("exits 0 even when accuracy is low (no --min-accuracy)", async () => {
    const h = harness({
      createProvider: (name, options) => ({
        name,
        model: options.model ?? "x",
        async complete() {
          return { json: ANSWERS["MARKER-C"] };
        },
      }),
    });
    expect(await main(["test", SET, FIXTURE], h.deps)).toBe(0);
  });

  it("runs the shipped support-triage examples with a fake provider", async () => {
    const h = harness({
      createProvider: (name, options) => ({
        name,
        model: options.model ?? "x",
        async complete() {
          return { json: ANSWERS["MARKER-A"] };
        },
      }),
    });
    expect(await main(["test", SET, SHIPPED], h.deps)).toBe(0);
    expect(h.out.stdout).toContain("support-triage: 12 examples");
    expect(h.out.stdout).toMatch(/^overall\s+\d+\/48\s/m);
  });
});

describe("decidekit test: errors", () => {
  async function fails(args: string[], message: RegExp, extra: Partial<CliDeps> = {}) {
    const h = harness(extra);
    expect(await main(args, h.deps)).toBe(1);
    expect(h.out.stderr).toMatch(message);
    expect(h.out.stdout).toBe("");
    return h;
  }

  it("usage errors suggest test --help", async () => {
    const h = await fails(["test", SET], /^decidekit test: missing the labelled examples file\n/);
    expect(h.out.stderr).toContain('Run "decidekit test --help" for usage.');
    await fails(["test"], /missing the question set and the labelled examples file/);
    await fails(["test", SET, FIXTURE, "extra"], /too many arguments: extra/);
    await fails(["test", SET, FIXTURE, "--tolerance=-1"], /--tolerance must be a number 0 or above, got "-1"/);
    await fails(["test", SET, FIXTURE, "--tolerance", "abc"], /--tolerance must be a number 0 or above/);
    await fails(["test", SET, FIXTURE, "--min-accuracy", "150"], /--min-accuracy must be a number from 0 to 100/);
    await fails(["test", SET, FIXTURE, "--provider", "openai"], /unknown provider "openai"/);
    await fails(["test", SET, FIXTURE, "--bogus"], /Unknown option '--bogus'/);
  });

  it("a missing examples file names the file", async () => {
    await fails(["test", SET, "nope.examples.yaml"], /^decidekit test: cannot read examples file "nope.examples.yaml": file not found\n$/);
  });

  it("an invalid examples file names the file, example and key, before any model call", async () => {
    const h = await fails(
      ["test", SET, "bad.examples.yaml"],
      /^decidekit test: bad\.examples\.yaml: example "x": expected "team": "Bills" is not one of the options \(Billing, Technical, Sales, Account\)\n$/,
      {
        readFile: async () => "examples:\n  - id: x\n    input: hi\n    expected:\n      team: Bills\n",
      },
    );
    expect(h.calls).toEqual([]);
    expect(h.created).toEqual([]);
  });

  it("a provider error exits 1 and names the example", async () => {
    await fails(["test", SET, FIXTURE], /^decidekit test: example "case-a": anthropic: HTTP 529 overloaded\n$/, {
      createProvider: (name, options) => ({
        name,
        model: options.model ?? "x",
        async complete() {
          throw new ProviderError("anthropic: HTTP 529 overloaded", { provider: "anthropic", status: 529 });
        },
      }),
    });
  });
});

describe("decidekit test --help", () => {
  it("shows the test usage with tolerance, json and exit codes", async () => {
    const h = harness();
    expect(await main(["test", "--help"], h.deps)).toBe(0);
    expect(h.out.stdout).toContain("Usage: decidekit test <set.yaml> <examples.yaml> [options]");
    expect(h.out.stdout).toContain("--tolerance <n>");
    expect(h.out.stdout).toContain("--min-accuracy <pct>");
    expect(h.out.stdout).toContain("--json");
    expect(h.out.stdout).toMatch(/Exit codes:\n\s+0\s+The test ran, whatever the accuracy/);
  });

  it("decidekit --help describes test", async () => {
    const h = harness();
    expect(await main(["--help"], h.deps)).toBe(0);
    expect(h.out.stdout).toContain("decidekit test <set.yaml> <examples.yaml> [--tolerance <n>]");
    expect(h.out.stdout).not.toContain("Not implemented");
  });
});
