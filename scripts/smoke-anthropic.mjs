// Optional live smoke test for the Anthropic provider.
//
//   npm run build && npm run smoke:anthropic
//
// Makes ONE small real API call (it costs a fraction of a cent) when
// ANTHROPIC_API_KEY is set in the environment. Without the key it prints a
// message and exits 0. It never prints the key. It does not load .env files.
import { existsSync } from "node:fs";

if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  console.log("smoke:anthropic skipped: ANTHROPIC_API_KEY is not set.");
  process.exit(0);
}

const distEntry = new URL("../dist/index.js", import.meta.url);
if (!existsSync(distEntry)) {
  console.error("smoke:anthropic: dist/index.js not found; run `npm run build` first.");
  process.exit(1);
}

const { anthropicProvider, decide, defineQuestions } = await import(distEntry.href);

const questions = defineQuestions({
  urgent: { type: "boolean", instructions: "Does this message need a reply today?" },
  team: { type: "choice", instructions: "Which team should handle it?", options: ["Billing", "Technical"] },
});

try {
  const provider = anthropicProvider();
  const result = await decide({
    provider,
    input: "I was charged twice this month. Please refund me today.",
    questions,
  });
  console.log(JSON.stringify(result, null, 2));
  const allOk = Object.values(result.answers).every((answer) => answer.ok);
  console.log(allOk ? "smoke:anthropic passed" : "smoke:anthropic: some answers failed validation");
  process.exit(allOk ? 0 : 1);
} catch (error) {
  // Provider errors never contain the key.
  console.error(`smoke:anthropic failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
