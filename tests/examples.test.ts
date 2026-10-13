import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// Imported from the module directly (not src/index.ts) so this test only
// depends on the R-1 loader.
import { loadQuestionSet } from "../src/questionSet.js";

const examplePath = (name: string): string =>
  fileURLToPath(new URL(`../examples/${name}`, import.meta.url));

interface ExpectedSet {
  name: string;
  questions: Record<string, string>;
  sections?: string[];
}

const EXPECTED: ExpectedSet[] = [
  {
    name: "support-triage",
    questions: {
      urgent: "boolean",
      team: "choice",
      refund_requested: "boolean",
      frustration: "score",
    },
  },
  {
    name: "invoice-check",
    questions: { amounts_match: "boolean", issue: "choice", needs_approval: "boolean" },
    sections: ["PURCHASE ORDER", "INVOICE"],
  },
  {
    name: "ai-answer-check",
    questions: {
      answered_question: "boolean",
      contains_dubious_claim: "boolean",
      tone: "choice",
      quality: "score",
    },
    sections: ["USER QUESTION:", "AI ANSWER:"],
  },
  {
    name: "content-moderation",
    questions: {
      spam: "boolean",
      category: "choice",
      needs_human_review: "boolean",
      severity: "score",
    },
  },
  {
    name: "lead-scoring",
    questions: {
      serious_buyer: "boolean",
      budget_mentioned: "boolean",
      company_size: "choice",
      priority: "score",
    },
  },
];

describe("example question sets", () => {
  for (const expected of EXPECTED) {
    describe(expected.name, () => {
      it("loads without errors and has the expected questions", async () => {
        const set = await loadQuestionSet(examplePath(`${expected.name}.yaml`));
        expect(set.name).toBe(expected.name);
        const types = Object.fromEntries(
          Object.entries(set.questions).map(([key, q]) => [key, q.type]),
        );
        expect(types).toEqual(expected.questions);
        for (const q of Object.values(set.questions)) {
          // Clear instructions, not one-word prompts.
          expect(q.instructions.length).toBeGreaterThan(40);
        }
      });

      it("has a non-empty sample input file", async () => {
        const text = await readFile(examplePath(`${expected.name}.input.txt`), "utf8");
        expect(text.trim().length).toBeGreaterThan(0);
        for (const section of expected.sections ?? []) {
          expect(text).toMatch(new RegExp(`^${section}`, "m"));
        }
      });
    });
  }

  it("has a sample input for every question set in examples/", async () => {
    const files = await readdir(fileURLToPath(new URL("../examples/", import.meta.url)));
    // Labelled examples files (*.examples.yaml, R-6) are not question sets.
    const sets = files.filter((f) => f.endsWith(".yaml") && !f.endsWith(".examples.yaml"));
    expect(sets.length).toBeGreaterThanOrEqual(5);
    for (const set of sets) {
      expect(files).toContain(set.replace(/\.yaml$/, ".input.txt"));
    }
  });

  it("keeps number-like choice options as strings", async () => {
    const set = await loadQuestionSet(examplePath("lead-scoring.yaml"));
    const q = set.questions.company_size;
    expect(q?.type).toBe("choice");
    if (q?.type === "choice") {
      expect(q.options).toEqual(["1-50", "51-250", "251-1000", "1000+"]);
    }
  });

  it("uses integer scores with the documented ranges", async () => {
    const ranges: [string, string, number, number][] = [
      ["support-triage", "frustration", 1, 5],
      ["ai-answer-check", "quality", 1, 10],
      ["content-moderation", "severity", 0, 3],
      ["lead-scoring", "priority", 1, 5],
    ];
    for (const [file, key, min, max] of ranges) {
      const set = await loadQuestionSet(examplePath(`${file}.yaml`));
      expect(set.questions[key]).toMatchObject({ type: "score", min, max, integer: true });
    }
  });
});
