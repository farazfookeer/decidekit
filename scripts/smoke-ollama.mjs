#!/usr/bin/env node
/**
 * Optional smoke test against a real local Ollama server.
 *
 *   npm run smoke:ollama
 *
 * Runs one tiny decide() call through the built library (dist/) using
 * ollamaProvider. Skips cleanly (exit code 0) when no Ollama server responds
 * or the model isn't installed. Not part of `npm test`.
 *
 * Environment:
 *   DECIDEKIT_OLLAMA_MODEL  model to use (default "llama3.2")
 *   OLLAMA_HOST             server address (default http://localhost:11434)
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const model = process.env.DECIDEKIT_OLLAMA_MODEL?.trim() || "llama3.2";
const distEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

if (!existsSync(distEntry)) {
  console.error("smoke:ollama: dist/index.js not found. Run `npm run build` first.");
  process.exit(1);
}

const { decide, defineQuestions, ollamaProvider } = await import(pathToFileURL(distEntry).href);

// Resolve the same base URL the provider will use (OLLAMA_HOST or default).
const provider = ollamaProvider({ model });
const { normalizeOllamaBaseUrl, OLLAMA_DEFAULT_BASE_URL } = await import(
  pathToFileURL(fileURLToPath(new URL("../dist/providers/ollama.js", import.meta.url))).href
);
const host = process.env.OLLAMA_HOST?.trim();
const baseUrl = host ? normalizeOllamaBaseUrl(host) : OLLAMA_DEFAULT_BASE_URL;

let tags;
try {
  const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  tags = await res.json();
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.log(`smoke:ollama: SKIPPED - no Ollama server responded at ${baseUrl} (${reason}). Start one with \`ollama serve\`.`);
  process.exit(0);
}

const installed = Array.isArray(tags?.models) ? tags.models.map((m) => String(m?.name ?? "")) : [];
const hasModel = installed.some((name) => name === model || name === `${model}:latest`);
if (!hasModel) {
  console.log(`smoke:ollama: SKIPPED - model "${model}" is not installed. Run \`ollama pull ${model}\` or set DECIDEKIT_OLLAMA_MODEL.`);
  process.exit(0);
}

const questions = defineQuestions({
  urgent: { type: "boolean", instructions: "Does this message need a reply today?" },
  team: { type: "choice", instructions: "Which team should handle it?", options: ["Billing", "Technical", "Sales"] },
});

console.log(`smoke:ollama: running decide() with ${model} at ${baseUrl} ...`);
try {
  const result = await decide({
    provider,
    input: "I was charged twice this month and need a refund before Friday.",
    questions,
  });
  console.log(JSON.stringify(result, null, 2));
  console.log("smoke:ollama: OK");
} catch (error) {
  console.error(`smoke:ollama: FAILED - ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
