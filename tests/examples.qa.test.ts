// QA integration tests for R-7 (example question sets). No network: uses the
// scripted fake provider. Written by qa-2 (Ibn Rushd).
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildPrompt, buildSchema, decide, loadQuestionSet, parseQuestionSet } from "../src/index.js";
import type { Question } from "../src/index.js";
import { createFakeProvider } from "./helpers/fakeProvider.js";

const dir = fileURLToPath(new URL("../examples/", import.meta.url));
const NAMES = ["support-triage", "invoice-check", "ai-answer-check", "content-moderation", "lead-scoring"];
const ALLOWED_TOP = new Set(["name", "version", "description", "questions"]);

function validAnswer(q: Question): Record<string, unknown> {
  switch (q.type) {
    case "boolean":
      return { value: true, confidence: 0.8 };
    case "choice": {
      const share = 1 / q.options.length;
      return { value: q.options[0], scores: Object.fromEntries(q.options.map((o) => [o, share])) };
    }
    case "score":
      return { value: q.max };
  }
}

describe("R-7 examples (QA)", () => {
  it("examples/ contains exactly the five named sets, each with an input file", async () => {
    const files = await readdir(dir);
    const sets = files.filter((f) => f.endsWith(".yaml") && !f.endsWith(".examples.yaml")).map((f) => f.replace(/\.yaml$/, ""));
    expect(sets.sort()).toEqual([...NAMES].sort());
    for (const n of NAMES) expect(files).toContain(`${n}.input.txt`);
  });

  for (const name of NAMES) {
    describe(name, () => {
      it("loads through the public API and the file name matches the set name", async () => {
        const set = await loadQuestionSet(`${dir}${name}.yaml`);
        expect(set.name).toBe(name);
        expect(set.description?.length ?? 0).toBeGreaterThan(10);
      });

      it("uses only documented top-level fields and question-key syntax", async () => {
        const raw = parse(await readFile(`${dir}${name}.yaml`, "utf8")) as Record<string, unknown>;
        for (const k of Object.keys(raw)) expect(ALLOWED_TOP.has(k)).toBe(true);
        for (const k of Object.keys(raw.questions as object)) expect(k).toMatch(/^[a-z][a-z0-9_]*$/);
      });

      it("parses identically with parseQuestionSet", async () => {
        const text = await readFile(`${dir}${name}.yaml`, "utf8");
        const a = parseQuestionSet(text, name);
        const b = await loadQuestionSet(`${dir}${name}.yaml`);
        expect(a.questions).toEqual(b.questions);
      });

      it("runs end to end with decide() on its sample input (fake provider)", async () => {
        const set = await loadQuestionSet(`${dir}${name}.yaml`);
        const input = await readFile(`${dir}${name}.input.txt`, "utf8");
        const answers = Object.fromEntries(Object.entries(set.questions).map(([k, q]) => [k, validAnswer(q)]));
        const provider = createFakeProvider([answers]);
        const result = await decide({ provider, input, questions: set });
        for (const key of Object.keys(set.questions)) {
          const ans = result.answers[key] as { ok?: boolean; error?: unknown };
          expect(ans.error, `${name}.${key}`).toBeUndefined();
          expect(ans.ok, `${name}.${key}`).toBe(true);
        }
        expect(provider.calls).toHaveLength(1);
        // The input text reaches the provider unchanged.
        expect(JSON.stringify(provider.calls[0])).toContain(JSON.stringify(input.trim()).slice(1, 40));
      });

      it("builds a prompt containing every instruction and the labelled sections", async () => {
        const set = await loadQuestionSet(`${dir}${name}.yaml`);
        const input = await readFile(`${dir}${name}.input.txt`, "utf8");
        const prompt = buildPrompt({ questions: set.questions, input, schema: buildSchema(set.questions) });
        for (const q of Object.values(set.questions)) expect(prompt).toContain(q.instructions.trim());
        expect(prompt).toContain(input.trim().split("\n")[0]);
      });
    });
  }

  it("multi-part inputs label every section that the instructions refer to", async () => {
    const pairs: [string, string[]][] = [
      ["invoice-check", ["PURCHASE ORDER", "INVOICE"]],
      ["ai-answer-check", ["USER QUESTION", "AI ANSWER"]],
    ];
    for (const [name, labels] of pairs) {
      const yamlText = await readFile(`${dir}${name}.yaml`, "utf8");
      const input = await readFile(`${dir}${name}.input.txt`, "utf8");
      for (const label of labels) {
        expect(yamlText).toContain(label);
        expect(input).toMatch(new RegExp(`^${label}:?\\s*$`, "m"));
      }
    }
  });

  it("sample inputs use no real-looking contact details", async () => {
    for (const name of NAMES) {
      const input = await readFile(`${dir}${name}.input.txt`, "utf8");
      expect(input).not.toMatch(/[\w.+-]+@[\w-]+\.\w+/); // no email addresses
      expect(input).not.toMatch(/\+?\d[\d ()-]{8,}\d/); // no phone numbers
      for (const host of input.match(/(?:https?:\/\/|www\.)[^\s]+/g) ?? []) {
        expect(host).toMatch(/example\.(com|org|net)/);
      }
    }
  });
});
