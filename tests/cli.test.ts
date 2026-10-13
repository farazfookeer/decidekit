import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import type { CliDeps, CreateProviderOptions, ProviderName } from "../src/cli.js";
import { defaultCreateProvider, resolveModel } from "../src/cli/shared.js";
import { ProviderError } from "../src/index.js";
import type { Provider } from "../src/index.js";
import { createFakeProvider } from "./helpers/fakeProvider.js";
import type { FakeStep } from "./helpers/fakeProvider.js";

const SET = "examples/support-triage.yaml";
const INPUT = "examples/support-triage.input.txt";

const GOOD_ANSWERS = {
  urgent: { value: true, confidence: 0.93 },
  team: { value: "Billing", scores: { Billing: 0.91, Technical: 0.02, Sales: 0.01, Account: 0.06 } },
  refund_requested: { value: true, confidence: 0.97 },
  frustration: { value: 4 },
};

interface Harness {
  out: { stdout: string; stderr: string };
  providerCalls: { name: ProviderName; options: CreateProviderOptions }[];
  deps: Partial<CliDeps>;
}

function harness(steps: readonly FakeStep[] = [GOOD_ANSWERS], extra: Partial<CliDeps> = {}): Harness {
  const out = { stdout: "", stderr: "" };
  const providerCalls: Harness["providerCalls"] = [];
  const deps: Partial<CliDeps> = {
    stdout: (t) => {
      out.stdout += t;
    },
    stderr: (t) => {
      out.stderr += t;
    },
    readStdin: async () => {
      throw new Error("stdin not expected in this test");
    },
    env: {},
    createProvider: (name, options): Provider => {
      providerCalls.push({ name, options });
      return createFakeProvider(steps, { name, model: options.model ?? "default-model" });
    },
    ...extra,
  };
  return { out, providerCalls, deps };
}

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "decidekit-cli-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("decidekit run: readable output", () => {
  it("prints each answer with confidence, scores and a footer", async () => {
    const h = harness();
    const code = await main(["run", SET, INPUT], h.deps);
    expect(h.out.stderr).toBe("");
    expect(code).toBe(0);
    const lines = h.out.stdout.split("\n");
    expect(lines[0]).toBe("urgent             Yes   (confidence 0.93)");
    expect(lines[1]).toBe("team               Billing   (Billing 0.91 · Account 0.06 · Technical 0.02 · Sales 0.01)");
    expect(lines[2]).toBe("refund_requested   Yes   (confidence 0.97)");
    expect(lines[3]).toBe("frustration        4 / 5");
    expect(h.out.stdout).toMatch(/provider anthropic · model default-model · attempts 1 · latency \d+ ms/);
    expect(h.out.stdout).toContain("uncalibrated");
  });

  it("sends the whole input file as one text (labelled sections stay intact)", async () => {
    const file = join(tmp, "multi.txt");
    await writeFile(file, "PURCHASE ORDER:\n10 units at $5\n\nINVOICE:\n10 units at $6\n");
    let prompt = "";
    const h = harness([
      (req) => {
        prompt = req.prompt;
        return GOOD_ANSWERS;
      },
    ]);
    expect(await main(["run", SET, file], h.deps)).toBe(0);
    expect(prompt).toContain("PURCHASE ORDER:\n10 units at $5\n\nINVOICE:\n10 units at $6");
  });

  it("marks failed answers with their error", async () => {
    const bad = { ...GOOD_ANSWERS, frustration: { value: 9 } };
    const h = harness([bad, { frustration: { value: 9 } }]);
    expect(await main(["run", SET, INPUT], h.deps)).toBe(0);
    expect(h.out.stdout).toMatch(/^frustration\s+FAILED\s+"value" must be between 1 and 5, got 9 \(after retry\)$/m);
    expect(h.out.stdout).toContain("attempts 2");
  });
});

describe("decidekit run: --json and stdin", () => {
  it("--json prints only the full DecideResult as JSON", async () => {
    const h = harness();
    expect(await main(["run", SET, INPUT, "--json"], h.deps)).toBe(0);
    const parsed = JSON.parse(h.out.stdout) as { answers: Record<string, unknown>; meta: Record<string, unknown> };
    expect(parsed.answers.urgent).toEqual({ ok: true, value: true, confidence: 0.93 });
    expect(parsed.answers.frustration).toEqual({ ok: true, value: 4 });
    expect(parsed.meta).toMatchObject({ provider: "anthropic", model: "default-model", attempts: 1 });
    expect(typeof parsed.meta.latencyMs).toBe("number");
  });

  it("reads the text from stdin when the file is -", async () => {
    let prompt = "";
    const h = harness(
      [
        (req) => {
          prompt = req.prompt;
          return GOOD_ANSWERS;
        },
      ],
      { readStdin: async () => "Text from stdin: please refund me." },
    );
    expect(await main(["run", SET, "-"], h.deps)).toBe(0);
    expect(prompt).toContain("Text from stdin: please refund me.");
  });
});

describe("decidekit run: providers and models", () => {
  it("defaults to anthropic and passes no model, so the provider's own default applies", async () => {
    const h = harness();
    await main(["run", SET, INPUT], h.deps);
    expect(h.providerCalls).toEqual([{ name: "anthropic", options: { model: undefined } }]);
  });

  it("passes --model through", async () => {
    const h = harness();
    await main(["run", SET, INPUT, "--model", "claude-sonnet-4-5"], h.deps);
    expect(h.providerCalls[0]?.options.model).toBe("claude-sonnet-4-5");
  });

  it("ollama defaults to llama3.2, then DECIDEKIT_OLLAMA_MODEL, then --model", async () => {
    const a = harness();
    await main(["run", SET, INPUT, "--provider", "ollama"], a.deps);
    expect(a.providerCalls[0]).toEqual({ name: "ollama", options: { model: "llama3.2" } });

    const b = harness([GOOD_ANSWERS], { env: { DECIDEKIT_OLLAMA_MODEL: "qwen2.5" } });
    await main(["run", SET, INPUT, "--provider", "ollama"], b.deps);
    expect(b.providerCalls[0]?.options.model).toBe("qwen2.5");

    const c = harness([GOOD_ANSWERS], { env: { DECIDEKIT_OLLAMA_MODEL: "qwen2.5" } });
    await main(["run", SET, INPUT, "--provider=ollama", "--model", "mistral"], c.deps);
    expect(c.providerCalls[0]?.options.model).toBe("mistral");
  });

  it("resolveModel ignores blank values", () => {
    expect(resolveModel("ollama", " ", { DECIDEKIT_OLLAMA_MODEL: "" })).toBe("llama3.2");
    expect(resolveModel("anthropic", "", {})).toBeUndefined();
  });

  it("passes --max-input-chars to decide (input over the limit fails)", async () => {
    const h = harness();
    expect(await main(["run", SET, INPUT, "--max-input-chars", "10"], h.deps)).toBe(1);
    expect(h.out.stderr).toMatch(/more than maxInputChars \(10\)/);
    expect(h.out.stdout).toBe("");
  });
});

describe("decidekit run: errors", () => {
  async function fails(args: string[], expected: RegExp, extra: Partial<CliDeps> = {}, usageHint = false) {
    const h = harness([GOOD_ANSWERS], extra);
    const code = await main(args, h.deps);
    expect(code).toBe(1);
    expect(h.out.stdout).toBe("");
    const [first, second] = h.out.stderr.split("\n");
    expect(first).toMatch(expected);
    if (usageHint) expect(second).toBe('Run "decidekit run --help" for usage.');
    return h;
  }

  it("missing arguments", async () => {
    await fails(["run"], /^decidekit run: missing the question set and the input file$/, {}, true);
    await fails(["run", SET], /missing the input file \(or - for stdin\)/, {}, true);
  });

  it("too many arguments", async () => {
    await fails(["run", SET, INPUT, "extra.txt"], /too many arguments: extra\.txt/, {}, true);
  });

  it("unknown option", async () => {
    await fails(["run", SET, INPUT, "--nope"], /Unknown option '--nope'/, {}, true);
  });

  it("unknown provider", async () => {
    await fails(["run", SET, INPUT, "--provider", "openai"], /unknown provider "openai"; use one of: anthropic, ollama/, {}, true);
  });

  it("bad --max-input-chars", async () => {
    await fails(["run", SET, INPUT, "--max-input-chars", "abc"], /--max-input-chars must be a positive whole number/, {}, true);
    await fails(["run", SET, INPUT, "--max-input-chars", "0"], /--max-input-chars must be a positive whole number/, {}, true);
  });

  it("missing question set file", async () => {
    await fails(["run", "nope/missing.yaml", INPUT], /^decidekit run: cannot read question set "nope\/missing\.yaml": file not found$/);
  });

  it("question set path that is a directory", async () => {
    await fails(["run", "examples", INPUT], /^decidekit run: cannot read question set "examples": it is a directory, not a file$/);
  });

  it("test with a missing question set file gets the same friendly message", async () => {
    const h = harness();
    expect(await main(["test", "nope/missing.yaml", "x.yaml"], h.deps)).toBe(1);
    expect(h.out.stderr).toBe('decidekit test: cannot read question set "nope/missing.yaml": file not found\n');
  });

  it("rejects input with NUL bytes before creating the provider", async () => {
    const file = join(tmp, "binary.bin");
    await writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x41, 0x42]));
    const h = await fails(["run", SET, file], /^decidekit run: input file ".*binary\.bin" does not look like text \(it contains NUL bytes\); give it UTF-8 text$/);
    expect(h.providerCalls).toEqual([]);
  });

  it("rejects input that is mostly invalid UTF-8 (stdin too)", async () => {
    const latin1 = Buffer.from([0xe9, 0xe8, 0xe0, 0xf9, 0xe7, 0x20, 0xe9, 0xe8]).toString("utf8");
    const h = await fails(["run", SET, "-"], /^decidekit run: stdin does not look like text \(it is not valid UTF-8\)/, {
      readStdin: async () => latin1,
    });
    expect(h.providerCalls).toEqual([]);
  });

  it("accepts text with an occasional replacement character", async () => {
    const h = harness([GOOD_ANSWERS], { readStdin: async () => `Caf\uFFFD is closed and my refund is late. ${"x".repeat(50)}` });
    expect(await main(["run", SET, "-"], h.deps)).toBe(0);
  });

  it("invalid question set", async () => {
    await fails(
      ["run", "tests/fixtures/question-sets/unknown-type.yaml", INPUT],
      /^decidekit run: tests\/fixtures\/question-sets\/unknown-type\.yaml: /,
    );
  });

  it("missing input file", async () => {
    await fails(["run", SET, "nope/missing.txt"], /^decidekit run: cannot read input file "nope\/missing\.txt": file not found$/);
  });

  it("empty input file and empty stdin", async () => {
    const file = join(tmp, "empty.txt");
    await writeFile(file, "  \n\n");
    await fails(["run", SET, file], /input file ".*empty\.txt" is empty/);
    await fails(["run", SET, "-"], /^decidekit run: stdin is empty/, { readStdin: async () => "" });
  });

  it("provider errors (missing key, Ollama unreachable) give one line and exit 1", async () => {
    await fails(["run", SET, INPUT], /^decidekit run: anthropic: no API key; set the ANTHROPIC_API_KEY.*--provider ollama/, {
      createProvider: () => {
        throw new ProviderError("anthropic: no API key; set the ANTHROPIC_API_KEY environment variable or pass the apiKey option");
      },
    });
    await fails(["run", SET, INPUT, "--provider", "ollama"], /Ollama isn't reachable/, {
      createProvider: (name, options) =>
        createFakeProvider(
          [new ProviderError("ollama: Ollama isn't reachable at http://localhost:11434. Is it running?")],
          { name, model: options.model ?? "" },
        ),
    });
  });

  it("test with a missing examples file fails clearly (full coverage in cliTest.test.ts)", async () => {
    const h = harness();
    expect(await main(["test", SET, "x.yaml"], h.deps)).toBe(1);
    expect(h.out.stderr).toContain('decidekit test: cannot read examples file "x.yaml": file not found');
  });

  it("unknown command suggests --help", async () => {
    const h = harness();
    expect(await main(["frobnicate"], h.deps)).toBe(1);
    expect(h.out.stderr).toBe('decidekit: unknown command "frobnicate"\nRun "decidekit --help" for usage.\n');
  });
});

describe("real provider factory (no network)", () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    vi.unstubAllGlobals();
  });

  it("without ANTHROPIC_API_KEY, run fails with the missing-key message before any fetch", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const h = harness([], { createProvider: defaultCreateProvider });
    expect(await main(["run", SET, INPUT], h.deps)).toBe(1);
    expect(h.out.stderr).toMatch(/^decidekit run: anthropic: no API key; set the ANTHROPIC_API_KEY environment variable/);
    expect(h.out.stderr).toContain("or use --provider ollama");
    expect(h.out.stderr).not.toContain("apiKey option");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("test without ANTHROPIC_API_KEY gives the CLI hint too", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.stubGlobal("fetch", vi.fn());
    const h = harness([], { createProvider: defaultCreateProvider });
    expect(await main(["test", SET, "examples/support-triage.examples.yaml"], h.deps)).toBe(1);
    expect(h.out.stderr).toBe(
      "decidekit test: anthropic: no API key; set the ANTHROPIC_API_KEY environment variable, or use --provider ollama to run a local model\n",
    );
  });

  it("an invalid key is reported without echoing it", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-secret-456\n";
    const h = harness([], { createProvider: defaultCreateProvider });
    expect(await main(["run", SET, INPUT], h.deps)).toBe(1);
    expect(h.out.stderr).toMatch(/invalid characters/);
    expect(h.out.stderr).not.toContain("sk-test-secret-456");
  });

  it("never prints the API key when the provider fails", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-secret-123";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "invalid x-api-key sk-test-secret-123" } }), { status: 401 })),
    );
    const h = harness([], { createProvider: defaultCreateProvider });
    expect(await main(["run", SET, INPUT], h.deps)).toBe(1);
    expect(h.out.stderr).toContain("HTTP 401");
    expect(h.out.stderr).not.toContain("sk-test-secret-123");
    expect(h.out.stderr.trim().split("\n")).toHaveLength(1);
  });

  it("ollama unreachable gives a clear message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const h = harness([], { createProvider: defaultCreateProvider, env: {} });
    expect(await main(["run", SET, INPUT, "--provider", "ollama"], h.deps)).toBe(1);
    expect(h.out.stderr).toMatch(/^decidekit run: ollama: Ollama isn't reachable at .*ollama serve/);
  });
});

describe("decidekit --help", () => {
  it("documents run and test", async () => {
    const h = harness();
    expect(await main(["--help"], h.deps)).toBe(0);
    expect(h.out.stdout).toContain("decidekit run <set.yaml> <file|->");
    expect(h.out.stdout).toContain("--provider anthropic|ollama");
    expect(h.out.stdout).toContain("--json");
    expect(h.out.stdout).toContain("decidekit test <set.yaml> <examples.yaml> [--tolerance <n>]");
    expect(h.out.stdout).toContain("--version");
  });

  it("run --help shows the run usage", async () => {
    const h = harness();
    expect(await main(["run", "--help"], h.deps)).toBe(0);
    expect(h.out.stdout).toContain("Usage: decidekit run <set.yaml> <file|-> [options]");
    expect(h.out.stdout).toContain("--max-input-chars");
    expect(h.providerCalls).toHaveLength(0);
  });

  it("every help lists all four environment variables", async () => {
    for (const argv of [["--help"], ["run", "--help"], ["test", "--help"]]) {
      const h = harness();
      expect(await main(argv, h.deps)).toBe(0);
      const env = h.out.stdout.slice(h.out.stdout.indexOf("Environment:"));
      expect(h.out.stdout).toContain("Environment:");
      for (const name of ["ANTHROPIC_API_KEY", "DECIDEKIT_MODEL", "DECIDEKIT_OLLAMA_MODEL", "OLLAMA_HOST"]) {
        expect(env).toMatch(new RegExp(`^  ${name}\\s`, "m"));
      }
    }
  });
});
