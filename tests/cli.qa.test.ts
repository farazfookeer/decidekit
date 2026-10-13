/**
 * QA (R-5, Ibn Rushd): integration tests for `decidekit run`, using a fake
 * provider through main() and, when dist/ is built, the real bin with
 * ANTHROPIC_API_KEY unset (it fails before any fetch). No network.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import type { CliDeps } from "../src/cli.js";
import { defaultCreateProvider } from "../src/cli/shared.js";
import type { Provider } from "../src/index.js";
import { createFakeProvider } from "./helpers/fakeProvider.js";
import type { FakeStep } from "./helpers/fakeProvider.js";

const SET = "examples/support-triage.yaml";
const INPUT = "examples/support-triage.input.txt";
const GOOD = {
  urgent: { value: true, confidence: 0.93 },
  team: { value: "Billing", scores: { Billing: 0.91, Technical: 0.02, Sales: 0.01, Account: 0.06 } },
  refund_requested: { value: true, confidence: 0.97 },
  frustration: { value: 4 },
};

function harness(steps: readonly FakeStep[], extra: Partial<CliDeps> = {}) {
  const out = { stdout: "", stderr: "", providersCreated: 0 };
  const deps: Partial<CliDeps> = {
    stdout: (t) => {
      out.stdout += t;
    },
    stderr: (t) => {
      out.stderr += t;
    },
    readStdin: async () => {
      throw new Error("stdin not expected");
    },
    env: {},
    createProvider: (name, options): Provider => {
      out.providersCreated++;
      return createFakeProvider(steps, { name, model: options.model ?? "m" });
    },
    ...extra,
  };
  return { out, deps };
}

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "decidekit-cli-qa-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("QA run: human layout", () => {
  it("aligns the answer column for long and short question keys, including FAILED rows", async () => {
    const longKey = "does_the_customer_mention_a_competitor_by_name";
    const set = join(tmp, "long.yaml");
    await writeFile(
      set,
      [
        "name: long",
        "questions:",
        `  ${longKey}:`,
        "    type: boolean",
        "    instructions: x",
        "  t:",
        "    type: choice",
        "    instructions: x",
        "    options: [A, B]",
        "  s:",
        "    type: score",
        "    instructions: x",
        "    min: -10",
        "    max: 10",
        "",
      ].join("\n"),
    );
    const bad = { [longKey]: { value: true, confidence: 0.5 }, t: { value: "Z" }, s: { value: 3 } };
    const h = harness([bad, { t: { value: "Z" } }]);
    expect(await main(["run", set, INPUT], h.deps)).toBe(0);
    const rows = h.out.stdout.split("\n").slice(0, 3);
    const col = longKey.length + 3;
    for (const row of rows) {
      expect(row.slice(0, col).trimEnd().length).toBeGreaterThan(0);
      expect(row[col - 1]).toBe(" ");
      expect(row[col]).not.toBe(" ");
    }
    expect(rows[0]).toBe(`${longKey}   Yes   (confidence 0.50)`);
    expect(rows[1]).toMatch(/^t\s+FAILED\s+/);
    expect(rows[2]).toMatch(/^s\s+3 \/ 10   \(range -10 to 10\)$/);
  });

  it("puts the uncalibrated note in the footer and nothing on stderr", async () => {
    const h = harness([GOOD]);
    expect(await main(["run", SET, INPUT], h.deps)).toBe(0);
    expect(h.out.stderr).toBe("");
    expect(h.out.stdout).toMatch(/uncalibrated/);
  });
});

describe("QA run: --json", () => {
  it("prints only parseable JSON even when answers are flagged, and flags come through", async () => {
    const bad = { ...GOOD, team: { value: "Nope" } };
    const h = harness([bad, { team: { value: "Nope" } }]);
    expect(await main(["run", "--json", SET, INPUT], h.deps)).toBe(0);
    const parsed = JSON.parse(h.out.stdout) as { answers: Record<string, { ok: boolean }>; meta: { attempts: number } };
    expect(parsed.answers.team?.ok).toBe(false);
    expect(parsed.meta.attempts).toBe(2);
    expect(h.out.stdout).not.toContain("uncalibrated");
    expect(h.out.stderr).toBe("");
  });

  it("on error, stdout stays empty (no partial JSON) and exit is 1", async () => {
    const h = harness([new Error("boom")]);
    expect(await main(["run", SET, INPUT, "--json"], h.deps)).toBe(1);
    expect(h.out.stdout).toBe("");
    expect(h.out.stderr).toMatch(/^decidekit run: .*boom/);
  });
});

describe("QA run: stdin", () => {
  it("reads stdin for '-' and sends it as the input, CRLF and unicode intact", async () => {
    const text = "PART A:\r\nCafé ✓ 日本\r\n\r\nPART B:\r\nok\r\n";
    let seen = "";
    const h = harness(
      [
        (req) => {
          seen = JSON.stringify(req);
          return GOOD;
        },
      ],
      { readStdin: async () => text },
    );
    expect(await main(["run", SET, "-"], h.deps)).toBe(0);
    expect(seen).toContain(JSON.stringify(text).slice(1, -1));
  });

  it("empty or whitespace stdin exits 1 without creating a provider", async () => {
    for (const text of ["", "   \n\t "]) {
      const h = harness([GOOD], { readStdin: async () => text });
      expect(await main(["run", SET, "-"], h.deps)).toBe(1);
      expect(h.out.stderr).toMatch(/stdin is empty/);
      expect(h.out.providersCreated).toBe(0);
    }
  });

  it("a stdin read failure exits 1 with a message", async () => {
    const h = harness([GOOD], {
      readStdin: async () => {
        throw new Error("EPIPE");
      },
    });
    expect(await main(["run", SET, "-"], h.deps)).toBe(1);
    expect(h.out.stderr).toMatch(/cannot read stdin: EPIPE/);
  });
});

describe("QA run: bad arguments never reach the provider", () => {
  const cases: [string, string[], RegExp][] = [
    ["no args", ["run"], /missing the question set/],
    ["one arg", ["run", SET], /missing the input file/],
    ["three positionals", ["run", SET, INPUT, "extra"], /too many arguments/],
    ["unknown flag", ["run", SET, INPUT, "--nope"], /Unknown option/],
    ["flag missing value", ["run", SET, INPUT, "--model"], /argument missing/],
    ["bad provider", ["run", SET, INPUT, "--provider", "openai"], /unknown provider "openai"/],
    ["negative max chars", ["run", SET, INPUT, "--max-input-chars", "-5"], /ambiguous|positive whole number/],
    ["fractional max chars", ["run", SET, INPUT, "--max-input-chars", "2.5"], /positive whole number/],
    ["missing set", ["run", "nope.yaml", INPUT], /nope\.yaml/],
    ["set is a directory", ["run", "examples", INPUT], /examples/],
    ["input is a directory", ["run", SET, "examples"], /directory/],
  ];
  for (const [label, argv, re] of cases) {
    it(label, async () => {
      const h = harness([GOOD]);
      expect(await main(argv, h.deps)).toBe(1);
      expect(h.out.stderr).toMatch(re);
      expect(h.out.stdout).toBe("");
      expect(h.out.providersCreated).toBe(0);
    });
  }

  it("--max-input-chars over the limit exits 1 with a clear message", async () => {
    const h = harness([GOOD]);
    expect(await main(["run", SET, INPUT, "--max-input-chars", "10"], h.deps)).toBe(1);
    expect(h.out.stderr).toMatch(/more than maxInputChars \(10\)/);
  });
});

const BIN = "dist/cli.js";
const hasBin = existsSync(BIN);

function runBin(args: string[], input?: string) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  env.OLLAMA_HOST = "http://127.0.0.1:1";
  const r = spawnSync(process.execPath, [BIN, ...args], { input: input ?? "", env, encoding: "utf8", timeout: 15000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe.skipIf(!hasBin)("QA built bin (no key, no network)", () => {
  it("--help documents run and test, exit 0", () => {
    const r = runBin(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/decidekit run <set\.yaml> <file\|->/);
    expect(r.stdout).toMatch(/decidekit test <set\.yaml> <examples\.yaml>/);
  });

  it("piped stdin is read (reaches the missing-key error), exit 1, stdout empty", () => {
    const r = runBin(["run", SET, "-"], "I was charged twice!");
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("empty piped stdin gives the empty-input message", () => {
    const r = runBin(["run", SET, "-"], "");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/stdin is empty/);
  });

  it("missing args give usage hint and exit 1", () => {
    const r = runBin(["run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Run "decidekit run --help"/);
  });

  it("--json with an error writes nothing to stdout", () => {
    const r = runBin(["run", SET, INPUT, "--json"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
  });

  // Real loopback probe: opt-in via DECIDEKIT_QA_LOOPBACK=1 so `npm test` stays network-free.
  // The mocked equivalent is "QA run: ollama unreachable (mocked ECONNREFUSED)" below.
  it.skipIf(process.env["DECIDEKIT_QA_LOOPBACK"] !== "1")("ollama unreachable on localhost gives a one-line message, exit 1", () => {
    const r = runBin(["run", SET, INPUT, "--provider", "ollama"]);
    expect(r.code).toBe(1);
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).toMatch(/Ollama isn't reachable/);
  });
});

describe("QA run: ollama unreachable (mocked ECONNREFUSED)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("real ollama provider with a refused connection gives a one-line message, exit 1, empty stdout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }),
        });
      }),
    );
    const h = harness([], { createProvider: defaultCreateProvider, env: {} });
    expect(await main(["run", SET, INPUT, "--provider", "ollama"], h.deps)).toBe(1);
    expect(h.out.stdout).toBe("");
    expect(h.out.stderr.trim().split("\n")).toHaveLength(1);
    expect(h.out.stderr).toMatch(/Ollama isn't reachable/);
    expect(h.out.stderr).toContain("ollama serve");
  });
});
