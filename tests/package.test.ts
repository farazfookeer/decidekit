/**
 * Checks the built package as a user would see it: the "exports" entry,
 * the bin, and what `npm pack` would publish. Needs `npm run build` first
 * (CI builds before testing); without dist/ these tests are skipped.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILT = existsSync(fileURLToPath(new URL("../dist/index.js", import.meta.url)));

if (!BUILT) {
  console.warn("tests/package.test.ts: dist/ not found, skipping package checks; run `npm run build` first.");
}

/** Runs a short ES module script with Node from the project root, so "decidekit" resolves by package self-reference. */
function runModule(source: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: ROOT, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe.skipIf(!BUILT)("built package", () => {
  it('import { decide } from "decidekit" resolves through package.json "exports" to dist/', () => {
    const r = runModule(`
      import { decide, defineQuestions, anthropicProvider, ollamaProvider, VERSION } from "decidekit";
      console.log(JSON.stringify({
        decide: typeof decide,
        defineQuestions: typeof defineQuestions,
        anthropicProvider: typeof anthropicProvider,
        ollamaProvider: typeof ollamaProvider,
        version: VERSION,
        resolved: import.meta.resolve("decidekit"),
      }));
    `);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, string>;
    expect(out).toMatchObject({
      decide: "function",
      defineQuestions: "function",
      anthropicProvider: "function",
      ollamaProvider: "function",
    });
    expect(out.resolved).toMatch(/\/dist\/index\.js$/);
  });

  it("decide works end to end from the built package with a fake provider (no network)", () => {
    const r = runModule(`
      import { decide, defineQuestions } from "decidekit";
      const provider = {
        name: "fake",
        model: "fake-1",
        async complete() { return { json: { urgent: { value: true, confidence: 0.9 } } }; },
      };
      const questions = defineQuestions({ urgent: { type: "boolean", instructions: "Urgent?" } });
      const result = await decide({ provider, input: "Help, the site is down!", questions });
      console.log(JSON.stringify(result.answers));
    `);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ urgent: { ok: true, value: true, confidence: 0.9 } });
  });

  it("node dist/cli.js --help exits 0", () => {
    const r = spawnSync(process.execPath, ["dist/cli.js", "--help"], { cwd: ROOT, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  it("npm pack includes dist/, README and LICENSE but no tests or sources", () => {
    const json = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: ROOT,
      encoding: "utf8",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [pack] = JSON.parse(json) as { files: { path: string }[] }[];
    const files = (pack?.files ?? []).map((f) => f.path);
    expect(files).toEqual(expect.arrayContaining(["dist/index.js", "dist/index.d.ts", "dist/cli.js", "README.md", "LICENSE", "package.json"]));
    expect(files.filter((f) => f.startsWith("tests/") || f.startsWith("src/") || f.startsWith("scripts/"))).toEqual([]);
    expect(files.filter((f) => /\.test\./.test(f) || /(^|\/)\.env/.test(f))).toEqual([]);
  });
});
