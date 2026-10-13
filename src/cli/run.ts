/**
 * `decidekit run <set.yaml> <file|->`: answers a question set about one text.
 */
import { parseArgs } from "node:util";
import { decide } from "../decide.js";
import type { DecideResult } from "../decide.js";
import { loadQuestionSet } from "../questionSet.js";
import type { Question, QuestionSet } from "../types.js";
import {
  CliUsageError,
  parsePositiveInt,
  parseProviderName,
  readInputText,
  resolveModel,
} from "./shared.js";
import type { CliDeps } from "./shared.js";

export const RUN_USAGE = `Usage: decidekit run <set.yaml> <file|-> [options]

Answer every question in a question set about one text.

Arguments:
  <set.yaml>               The question set (YAML)
  <file|->                 The text to analyse (UTF-8), or - to read it from stdin.
                           For multi-part inputs, put labelled sections in the
                           file (for example "PURCHASE ORDER:" and "INVOICE:").

Options:
  --provider <name>        anthropic (default) or ollama
  --model <id>             Model id. anthropic: DECIDEKIT_MODEL or claude-haiku-4-5;
                           ollama: DECIDEKIT_OLLAMA_MODEL or llama3.2
  --json                   Print the full result as JSON
  --max-input-chars <n>    Reject input longer than n characters (never truncated)
  -h, --help               Show this help

Environment:
  ANTHROPIC_API_KEY        Required for the anthropic provider
  DECIDEKIT_MODEL          Claude model for the anthropic provider when --model is
                           not given (default claude-haiku-4-5)
  DECIDEKIT_OLLAMA_MODEL   Default model for the ollama provider when --model is
                           not given (default llama3.2)
  OLLAMA_HOST              Ollama server address (default http://localhost:11434)

Confidence and choice scores are the model's own estimates and are uncalibrated.`;

const COMMAND = "run";

function fmt(n: number): string {
  return n.toFixed(2);
}

function formatAnswer(question: Question | undefined, answer: unknown): string {
  const a = answer as { ok: boolean; error?: string; value?: unknown; confidence?: number; scores?: Record<string, number> };
  if (!a.ok) return `FAILED   ${a.error ?? "invalid answer"}`;
  if (question?.type === "boolean") {
    const conf = typeof a.confidence === "number" ? `   (confidence ${fmt(a.confidence)})` : "";
    return `${a.value === true ? "Yes" : "No"}${conf}`;
  }
  if (question?.type === "choice") {
    const scores = Object.entries(a.scores ?? {}).sort(([, x], [, y]) => y - x);
    const detail = scores.length > 0 ? `   (${scores.map(([o, s]) => `${o} ${fmt(s)}`).join(" · ")})` : "";
    return `${String(a.value)}${detail}`;
  }
  if (question?.type === "score") {
    const range = question.min === 0 || question.min === 1 ? "" : `   (range ${question.min} to ${question.max})`;
    return `${String(a.value)} / ${question.max}${range}`;
  }
  return String(a.value);
}

/** Formats a decide() result as a readable, aligned table plus a footer. */
export function formatRunResult(set: QuestionSet, result: DecideResult): string {
  const keys = Object.keys(result.answers);
  const width = Math.max(...keys.map((k) => k.length), 0) + 3;
  const lines = keys.map((key) => `${key.padEnd(width)}${formatAnswer(set.questions[key], result.answers[key])}`);
  const { provider, model, attempts, latencyMs } = result.meta;
  lines.push(
    "",
    `provider ${provider} · model ${model} · attempts ${attempts} · latency ${latencyMs} ms`,
    "Confidence and scores are the model's own estimates (uncalibrated).",
  );
  return `${lines.join("\n")}\n`;
}

/** Runs `decidekit run`. Returns the exit code; throws on errors. */
export async function runCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        provider: { type: "string" },
        model: { type: "string" },
        json: { type: "boolean" },
        "max-input-chars": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error), COMMAND);
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    deps.stdout(`${RUN_USAGE}\n`);
    return 0;
  }
  if (positionals.length < 2) {
    const missing = positionals.length === 0 ? "the question set and the input file" : "the input file (or - for stdin)";
    throw new CliUsageError(`missing ${missing}`, COMMAND);
  }
  if (positionals.length > 2) {
    throw new CliUsageError(
      `too many arguments: ${positionals.slice(2).join(" ")} (input is one text; put multi-part inputs in labelled sections of one file)`,
      COMMAND,
    );
  }
  const [setPath, inputPath] = positionals as [string, string];
  const providerName = parseProviderName(values.provider, COMMAND);
  const maxInputChars = parsePositiveInt(values["max-input-chars"], "--max-input-chars", COMMAND);
  const model = resolveModel(providerName, values.model, deps.env);

  const set = await loadQuestionSet(setPath);
  const input = await readInputText(inputPath, deps);
  const provider = deps.createProvider(providerName, { model });

  const result = await decide(
    maxInputChars === undefined
      ? { provider, input, questions: set }
      : { provider, input, questions: set, maxInputChars },
  );

  deps.stdout(values.json === true ? `${JSON.stringify(result, null, 2)}\n` : formatRunResult(set, result));
  return 0;
}
