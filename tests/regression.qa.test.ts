/**
 * QA final regression pass (Ibn Rushd): cross-cutting checks against the BUILT
 * package, loaded through the package's own name ("decidekit" self-reference,
 * i.e. the `exports` entry), plus the built CLI's main() with injected deps.
 *
 * Network policy: no real network. The only fetch used is a vi.fn() stub that
 * returns canned Anthropic API envelopes; it is restored after each test.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/index.js";

type Lib = typeof import("../src/index.js");
type Cli = typeof import("../src/cli.js");

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const BUILT = existsSync(join(ROOT, "dist", "index.js")) && existsSync(join(ROOT, "dist", "cli.js"));
const ex = (f: string) => join(ROOT, "examples", f);

// Dynamic, non-literal specifiers so `npm run typecheck` does not need dist/.
const PKG = "decidekit";
const loadLib = async (): Promise<Lib> => (await import(PKG)) as Lib;
const loadCli = async (): Promise<Cli> => (await import(join(ROOT, "dist", "cli.js"))) as Cli;

function fake(steps: unknown[]): Provider & { calls: ProviderRequest[] } {
  const calls: ProviderRequest[] = [];
  return {
    name: "fake",
    model: "fake-model",
    calls,
    async complete(request): Promise<ProviderResponse> {
      calls.push(request);
      if (steps.length === 0) throw new Error("fake: out of steps");
      return { json: steps.shift() };
    },
  };
}

const TRIAGE_GOOD = {
  urgent: { value: true, confidence: 0.9 },
  team: { value: "Billing", scores: { Billing: 0.7, Technical: 0.2, Sales: 0.05, Account: 0.05 } },
  refund_requested: { value: true, confidence: 0.8 },
  frustration: { value: 4 },
};

const SECRET = "sk-ant-api03-QA-REGRESSION-SECRET-zzz";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.skipIf(!BUILT)("regression: built package entry point", () => {
  it("decide, defineQuestions, providers and loaders import from the package name", async () => {
    const lib = await loadLib();
    for (const name of ["decide", "defineQuestions", "anthropicProvider", "ollamaProvider", "loadQuestionSet", "loadExamples"] as const) {
      expect(typeof lib[name]).toBe("function");
    }
  });

  it("all five example sets load and validate; support-triage has >= 8 labelled examples", async () => {
    const lib = await loadLib();
    const names = ["support-triage", "content-moderation", "invoice-check", "lead-scoring", "ai-answer-check"];
    const types = new Set<string>();
    for (const n of names) {
      const set = await lib.loadQuestionSet(ex(`${n}.yaml`));
      expect(set.name).toBe(n);
      for (const q of Object.values(set.questions)) types.add(q.type);
    }
    expect([...types].sort()).toEqual(["boolean", "choice", "score"]);
    const triage = await lib.loadQuestionSet(ex("support-triage.yaml"));
    const labelled = await lib.loadExamples(ex("support-triage.examples.yaml"), triage);
    expect(labelled.length).toBeGreaterThanOrEqual(8);
  });

  it("YAML set: answers boolean, choice and score in one call", async () => {
    const lib = await loadLib();
    const set = await lib.loadQuestionSet(ex("support-triage.yaml"));
    const p = fake([TRIAGE_GOOD]);
    const r = await lib.decide({ provider: p, input: "Charged twice, refund please!", questions: set });
    expect(r.answers["urgent"]).toEqual({ ok: true, value: true, confidence: 0.9 });
    expect(r.answers["team"]).toMatchObject({ ok: true, value: "Billing" });
    expect(r.answers["frustration"]).toEqual({ ok: true, value: 4 });
    expect(r.meta.attempts).toBe(1);
    expect(p.calls).toHaveLength(1);
  });

  it("invalid answer is retried once (only the failing question) and then accepted", async () => {
    const lib = await loadLib();
    const set = await lib.loadQuestionSet(ex("support-triage.yaml"));
    const bad = { ...TRIAGE_GOOD, team: { value: "Marketing", scores: { Marketing: 1 } } };
    const p = fake([bad, { team: TRIAGE_GOOD.team }]);
    const r = await lib.decide({ provider: p, input: "x", questions: set });
    expect(r.answers["team"]).toMatchObject({ ok: true, value: "Billing" });
    expect(r.meta.attempts).toBe(2);
    expect(p.calls[1]?.schema.required).toEqual(["team"]);
  });

  it("answer still invalid after the retry is flagged ok:false with an error, no third call", async () => {
    const lib = await loadLib();
    const set = await lib.loadQuestionSet(ex("support-triage.yaml"));
    const bad = { ...TRIAGE_GOOD, frustration: { value: 9 } };
    const p = fake([bad, { frustration: { value: 0 } }, TRIAGE_GOOD]);
    const r = await lib.decide({ provider: p, input: "x", questions: set });
    const f = r.answers["frustration"];
    expect(f?.ok).toBe(false);
    expect(f && !f.ok ? f.error : "").toMatch(/frustration|range|between|1/i);
    expect(r.answers["urgent"]).toMatchObject({ ok: true });
    expect(p.calls).toHaveLength(2);
  });

  it("inline TypeScript questions work through the built entry", async () => {
    const lib = await loadLib();
    const questions = lib.defineQuestions({
      spam: { type: "boolean", instructions: "Is it spam?" },
      lang: { type: "choice", instructions: "Language", options: ["en", "fr"] },
      quality: { type: "score", instructions: "Quality", min: 0, max: 10 },
    });
    const p = fake([{ spam: { value: false, confidence: 0.6 }, lang: { value: "fr", scores: { en: 0.1, fr: 0.9 } }, quality: { value: 7.5 } }]);
    const r = await lib.decide({ provider: p, input: "Bonjour", questions });
    expect(r.answers.lang).toMatchObject({ ok: true, value: "fr" });
    expect(r.answers.quality).toEqual({ ok: true, value: 7.5 });
  });
});

describe.skipIf(!BUILT)("regression: built CLI end to end with a fake provider", () => {
  function deps(provider: Provider, env: Record<string, string | undefined> = {}) {
    let out = "";
    let err = "";
    return {
      d: {
        stdout: (t: string) => void (out += t),
        stderr: (t: string) => void (err += t),
        env,
        createProvider: () => provider,
      },
      out: () => out,
      err: () => err,
    };
  }

  it("decidekit run prints every answer and exits 0", async () => {
    const { main } = await loadCli();
    const h = deps(fake([TRIAGE_GOOD]));
    const code = await main(["run", ex("support-triage.yaml"), ex("support-triage.input.txt")], h.d);
    expect(code).toBe(0);
    for (const k of ["urgent", "team", "refund_requested", "frustration", "Billing"]) expect(h.out()).toContain(k);
  });

  it("decidekit run --json emits parseable JSON", async () => {
    const { main } = await loadCli();
    const h = deps(fake([TRIAGE_GOOD]));
    const code = await main(["run", ex("support-triage.yaml"), ex("support-triage.input.txt"), "--json"], h.d);
    expect(code).toBe(0);
    expect(() => JSON.parse(h.out())).not.toThrow();
  });

  it("decidekit test reports accuracy over the labelled examples and exits 0", async () => {
    const { main } = await loadCli();
    const steps = Array.from({ length: 50 }, () => TRIAGE_GOOD);
    const h = deps(fake(steps));
    const code = await main(["test", ex("support-triage.yaml"), ex("support-triage.examples.yaml")], h.d);
    expect(code).toBe(0);
    expect(h.out()).toMatch(/%/);
    expect(h.out()).toMatch(/team/);
  });

  it("real anthropic provider via the CLI with stubbed fetch never prints the API key (success and 401)", async () => {
    const { main } = await loadCli();
    const ok = new Response(
      JSON.stringify({
        id: "m",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [{ type: "tool_use", id: "t", name: "record_decisions", input: TRIAGE_GOOD }],
        stop_reason: "tool_use",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const unauthorized = new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${SECRET}` } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(ok).mockResolvedValueOnce(unauthorized);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ANTHROPIC_API_KEY", SECRET);
    try {
      const outs: string[] = [];
      const base = { stdout: (t: string) => void outs.push(t), stderr: (t: string) => void outs.push(t), env: { ANTHROPIC_API_KEY: SECRET } };
      const c1 = await main(["run", ex("support-triage.yaml"), ex("support-triage.input.txt")], base);
      const c2 = await main(["run", ex("support-triage.yaml"), ex("support-triage.input.txt"), "--json"], base);
      expect(c1).toBe(0);
      expect(c2).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const all = outs.join("");
      expect(all).not.toContain(SECRET);
      expect(all).not.toContain("QA-REGRESSION-SECRET");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
