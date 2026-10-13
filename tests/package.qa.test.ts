/**
 * QA (R-8, open-source packaging and docs): checks the docs and packaging the
 * way a newcomer meets them. No network: the only provider "call" goes to a
 * closed loopback port, and the API key is always unset.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { anthropicProvider, decide, defineQuestions, loadQuestionSet, ollamaProvider } from "../src/index.js";
import type { DecideMeta, Provider } from "../src/index.js";
import { main } from "../src/cli.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILT = existsSync(join(ROOT, "dist", "index.js"));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const DOCS = [
  "README.md",
  "CONTRIBUTING.md",
  "docs/README.md",
  "docs/api.md",
  "docs/question-set-format.md",
  "docs/labelled-examples-format.md",
  "examples/README.md",
];

const stripCode = (md: string): string => md.replace(/```[\s\S]*?```/g, "");
const slug = (heading: string): string =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
const anchorsOf = (rel: string): Set<string> =>
  new Set(
    stripCode(read(rel))
      .split("\n")
      .map((line) => /^#+\s+(.*)/.exec(line)?.[1])
      .filter((h): h is string => h !== undefined)
      .map(slug),
  );
const codeBlocks = (md: string, lang: string): string[] =>
  [...md.matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g"))].map((m) => m[1] ?? "");

describe("QA R-8: documentation links", () => {
  it.each(DOCS)("every relative link (and #anchor) in %s resolves", (rel) => {
    const broken: string[] = [];
    for (const m of stripCode(read(rel)).matchAll(/\]\(([^)\s]+)\)/g)) {
      const url = m[1] ?? "";
      if (/^https?:/.test(url)) continue;
      const [path = "", anchor] = url.split("#");
      const target = path === "" ? rel : join(dirname(rel), path);
      if (!existsSync(join(ROOT, target))) {
        broken.push(`${url} (missing ${target})`);
        continue;
      }
      if (anchor !== undefined && (statSync(join(ROOT, target)).isDirectory() || !anchorsOf(target).has(anchor))) {
        broken.push(`${url} (no heading #${anchor} in ${target})`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("QA R-8 criteria 1-3: README and CONTRIBUTING content", () => {
  const readme = read("README.md");

  it("README quick start covers install, build, and a first run with Claude and with Ollama", () => {
    expect(readme).toMatch(/npm install\nnpm run build/);
    expect(readme).toContain("export ANTHROPIC_API_KEY=");
    expect(readme).toContain("decidekit run triage.yaml message.txt");
    expect(readme).toContain("ollama pull llama3.2");
    expect(readme).toContain("decidekit run triage.yaml message.txt --provider ollama");
    expect(readme).toContain("node dist/cli.js");
  });

  it("README's sample triage.yaml is a valid question set with the documented questions", async () => {
    const yamlBlock = codeBlocks(readme, "yaml")[0] ?? "";
    const dir = mkdtempSync(join(tmpdir(), "decidekit-qa-yaml-"));
    try {
      writeFileSync(join(dir, "triage.yaml"), yamlBlock);
      const set = await loadQuestionSet(join(dir, "triage.yaml"));
      expect(set.name).toBe("triage");
      expect(Object.keys(set.questions)).toEqual(["urgent", "team", "frustration"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("README says confidence and scores are the model's own uncalibrated estimates, and notes prompt injection", () => {
    expect(readme).toMatch(/model's own estimates/);
    expect(readme).toMatch(/uncalibrated/);
    expect(readme).toMatch(/## Limitations[\s\S]*Prompt injection/);
  });

  it("CONTRIBUTING covers setup, tests and adding a provider", () => {
    const c = read("CONTRIBUTING.md");
    expect(c).toMatch(/^## Setup$/m);
    expect(c).toMatch(/^## Tests and checks$/m);
    expect(c).toMatch(/^## Adding a provider$/m);
    for (const cmd of ["npm install", "npm run typecheck", "npm run build", "npm test"]) expect(c).toContain(cmd);
    // Everything CONTRIBUTING tells a provider author to touch exists.
    const shared = read("src/cli/shared.ts");
    expect(shared).toContain("PROVIDER_NAMES");
    expect(shared).toContain("defaultCreateProvider");
    expect(shared).toContain("interface CliDeps");
    expect(read("src/providers/anthropic.ts")).toMatch(/function sanitiseError[\s\S]*|function redact/);
    expect(existsSync(join(ROOT, "tests/helpers/fakeProvider.ts"))).toBe(true);
  });
});

describe("QA R-8: README and docs TypeScript samples compile against the real API", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("every self-contained ```ts block in README, docs/api.md and examples/README type-checks", () => {
    const dir = mkdtempSync(join(tmpdir(), "decidekit-qa-snippets-"));
    dirs.push(dir);
    const files: string[] = [];
    for (const rel of ["README.md", "docs/api.md", "examples/README.md"]) {
      codeBlocks(read(rel), "ts")
        // Only blocks that import from "decidekit" are complete programs; the
        // rest are signatures or fragments, checked by the type test below.
        .filter((code) => code.includes('from "decidekit"'))
        .forEach((code, i) => {
          const name = `${rel.replace(/\W/g, "_")}_${i}.ts`;
          // Some samples (the errors one in docs/api.md) use provider/input/questions
          // as placeholders: declare whichever ones the sample doesn't define itself.
          const free = (["provider", "input", "questions"] as const)
            .filter((n) => !new RegExp(`const ${n}\\b`).test(code))
            .map((n) => `declare const ${n}: ${n === "provider" ? 'import("decidekit").Provider' : n === "input" ? "string" : 'import("decidekit").Questions'};`)
            .join("\n");
          writeFileSync(join(dir, name), `${code}\n${free}\nexport {};\n`);
          files.push(name);
        });
    }
    expect(files.length).toBeGreaterThanOrEqual(4);
    writeFileSync(join(dir, "package.json"), '{ "type": "module" }');
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          lib: ["ES2023", "DOM"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noUncheckedIndexedAccess: true,
          noEmit: true,
          skipLibCheck: true,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules", "@types")],
          paths: { decidekit: [join(ROOT, "src", "index.ts")] },
        },
        include: ["*.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
    const r = spawnSync(process.execPath, [tsc, "-p", dir], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  }, 60_000);

  it("the README library quick start's shapes match (type-level, enforced by npm run typecheck)", async () => {
    const questions = defineQuestions({
      urgent: { type: "boolean", instructions: "Does this message need a reply today?" },
      team: { type: "choice", instructions: "Which team should handle it?", options: ["Billing", "Technical", "Sales"] },
      frustration: { type: "score", instructions: "1 = calm, 5 = furious.", min: 1, max: 5, integer: true },
    });
    const provider: Provider = {
      name: "fake",
      model: "fake-1",
      async complete() {
        return {
          json: {
            urgent: { value: true, confidence: 0.9 },
            team: { value: "Billing", scores: { Billing: 0.9, Technical: 0.05, Sales: 0.05 } },
            frustration: { value: 3 },
          },
        };
      },
    };
    const result = await decide({ provider, input: "I was charged twice.", questions });
    const team = result.answers.team;
    expect(team.ok).toBe(true);
    if (team.ok) {
      const v: "Billing" | "Technical" | "Sales" = team.value;
      const s: { Billing: number; Technical: number; Sales: number } = team.scores;
      expect(v).toBe("Billing");
      expect(s.Billing).toBeCloseTo(0.9);
    }
    const meta: DecideMeta = result.meta;
    expect(Object.keys(meta).sort()).toEqual(["attempts", "latencyMs", "model", "provider"]);
    // README: anthropicProvider() with no key throws at construction; ollamaProvider({ model }) makes no call.
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => anthropicProvider()).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
    expect(ollamaProvider({ model: "llama3.2" }).model).toBe("llama3.2");
  });
});

describe("QA R-8 criterion 4: CI workflow", () => {
  const ci = parse(read(".github/workflows/ci.yml"), { strict: true, uniqueKeys: true }) as {
    on: Record<string, unknown>;
    jobs: Record<string, { "runs-on": string; strategy: { matrix: { node: number[] } }; steps: { run?: string; uses?: string; with?: Record<string, unknown> }[] }>;
  };

  it("is valid YAML with a Node 22 and 24 matrix, triggered on push and pull request", () => {
    expect(Object.keys(ci.on).sort()).toEqual(["pull_request", "push"]);
    const jobs = Object.values(ci.jobs);
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.strategy.matrix.node).toEqual([22, 24]);
    const setup = job.steps.find((s) => s.uses?.startsWith("actions/setup-node"));
    expect(setup?.with?.["node-version"]).toBe("${{ matrix.node }}");
  });

  it("runs npm ci, typecheck, build, then tests (build before test so package checks are not skipped)", () => {
    const runs = Object.values(ci.jobs)[0]!.steps.map((s) => s.run).filter((r): r is string => r !== undefined);
    const at = (cmd: string): number => runs.indexOf(cmd);
    for (const cmd of ["npm ci", "npm run typecheck", "npm run build", "npm test", "node dist/cli.js --help", "npm pack --dry-run"]) {
      expect(at(cmd), cmd).toBeGreaterThanOrEqual(0);
    }
    expect(at("npm ci")).toBeLessThan(at("npm run typecheck"));
    expect(at("npm run build")).toBeLessThan(at("npm test"));
  });
});

describe.skipIf(!BUILT)("QA R-8 criterion 5 and newcomer CLI walkthrough (built package)", () => {
  const cli = (args: string[], input?: string, env: Record<string, string> = {}) => {
    const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
    delete childEnv.ANTHROPIC_API_KEY;
    return spawnSync(process.execPath, [join(ROOT, "dist", "cli.js"), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      input,
      env: childEnv,
    });
  };

  it("dist/cli.js keeps its shebang so the bin works after install", () => {
    expect(read("dist/cli.js").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("README quick start with Claude and no key: friendly message, exit 1, pointing at ollama", () => {
    const r = cli(["run", "examples/support-triage.yaml", "examples/support-triage.input.txt"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^decidekit run: anthropic: no API key; set the ANTHROPIC_API_KEY environment variable, or use --provider ollama/);
  });

  // Real loopback probe: opt-in via DECIDEKIT_QA_LOOPBACK=1 so `npm test` stays network-free.
  // The mocked equivalent is in "QA R-8: README quick start with Ollama and no server (mocked)".
  it.skipIf(process.env["DECIDEKIT_QA_LOOPBACK"] !== "1")("README quick start with Ollama and no server: suggests `ollama serve`, exit 1 (closed loopback port)", () => {
    const r = cli(["run", "examples/support-triage.yaml", "examples/support-triage.input.txt", "--provider", "ollama"], undefined, {
      OLLAMA_HOST: "http://127.0.0.1:9",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ollama serve");
  });

  it("missing files and non-text stdin give one clear line and exit 1", () => {
    expect(cli(["run", "nope.yaml", "x.txt"]).stderr).toMatch(/cannot read question set "nope\.yaml": file not found/);
    expect(cli(["run", "examples/support-triage.yaml", "nope.txt"]).stderr).toMatch(/cannot read input file "nope\.txt": file not found/);
    const nul = cli(["run", "examples/support-triage.yaml", "-"], "a\u0000b");
    expect(nul.status).toBe(1);
    expect(nul.stderr).toMatch(/NUL/);
  });

  it("npm pack contains only dist/, README.md, LICENSE and package.json", () => {
    const json = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: ROOT,
      encoding: "utf8",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [pack] = JSON.parse(json) as { files: { path: string }[] }[];
    const files = (pack?.files ?? []).map((f) => f.path);
    const other = files.filter((f) => !f.startsWith("dist/") && !["README.md", "LICENSE", "package.json"].includes(f));
    expect(other).toEqual([]);
    expect(files).toEqual(expect.arrayContaining(["README.md", "LICENSE", "dist/index.js", "dist/cli.js"]));
  });
});

describe("QA R-8: README quick start with Ollama and no server (mocked)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refused connection (mocked ECONNREFUSED): suggests `ollama serve`, exit 1", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }),
        });
      }),
    );
    let stdout = "";
    let stderr = "";
    const code = await main(["run", "examples/support-triage.yaml", "examples/support-triage.input.txt", "--provider", "ollama"], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: (t) => {
        stderr += t;
      },
      env: { OLLAMA_HOST: "http://127.0.0.1:9" },
    });
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("ollama serve");
  });
});
