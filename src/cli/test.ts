/**
 * `decidekit test <set.yaml> <examples.yaml>`: measures accuracy against
 * labelled examples.
 */
import { parseArgs } from "node:util";
import { parseExamples } from "../examples.js";
import type { AccuracyCount, AccuracyReport, WrongAnswer } from "../examples.js";
import { measureAccuracy } from "../examples.js";
import { loadQuestionSet } from "../questionSet.js";
import { CliError, CliUsageError, parsePositiveInt, parseProviderName, resolveModel } from "./shared.js";
import type { CliDeps } from "./shared.js";

export const TEST_USAGE = `Usage: decidekit test <set.yaml> <examples.yaml> [options]

Measure accuracy: run every labelled example through the question set and
compare the answers with the expected ones.

Arguments:
  <set.yaml>               The question set (YAML)
  <examples.yaml>          Labelled examples for that set, usually
                           <set>.examples.yaml (see docs/labelled-examples-format.md)

Options:
  --provider <name>        anthropic (default) or ollama
  --model <id>             Model id. anthropic: DECIDEKIT_MODEL or claude-haiku-4-5;
                           ollama: DECIDEKIT_OLLAMA_MODEL or llama3.2
  --tolerance <n>          A score answer within n of the expected value counts
                           as correct (default 0: exact)
  --min-accuracy <pct>     Exit with code 1 if overall accuracy is below pct
                           (0 to 100). Useful in CI.
  --max-input-chars <n>    Reject example inputs longer than n characters
  --json                   Print the report as JSON
  -h, --help               Show this help

Environment:
  ANTHROPIC_API_KEY        Required for the anthropic provider
  DECIDEKIT_MODEL          Claude model for the anthropic provider when --model is
                           not given (default claude-haiku-4-5)
  DECIDEKIT_OLLAMA_MODEL   Default model for the ollama provider when --model is
                           not given (default llama3.2)
  OLLAMA_HOST              Ollama server address (default http://localhost:11434)

Correct means: boolean and choice answers equal the expected value; score
answers are within the tolerance. An answer the model never gave validly
(FAILED) counts as wrong. Questions an example doesn't label are not scored.

Exit codes:
  0   The test ran, whatever the accuracy (unless --min-accuracy is not met)
  1   Bad arguments, an unreadable or invalid file, a provider error, or
      overall accuracy below --min-accuracy

Each example is one model call (two if an answer needs a retry).`;

const COMMAND = "test";

function parseNonNegative(value: string | undefined, flag: string, max?: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const n = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(n) || n < 0 || (max !== undefined && n > max)) {
    const range = max === undefined ? "a number 0 or above" : `a number from 0 to ${max}`;
    throw new CliUsageError(`${flag} must be ${range}, got "${value}"`, COMMAND);
  }
  return n;
}

function pct(c: AccuracyCount): string {
  return c.accuracy === null ? "no labels" : `${(c.accuracy * 100).toFixed(1)}%`;
}

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function table(rows: readonly (readonly string[])[], indent = ""): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) =>
    `${indent}${row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd((widths[i] ?? 0) + 3))).join("")}`.trimEnd(),
  );
}

function wrongRow(w: WrongAnswer): string[] {
  const got = w.error !== undefined ? `FAILED (${w.error})` : show(w.got);
  return [w.example, w.question, `expected ${show(w.expected)}`, `got ${got}`];
}

/** Formats an accuracy report as readable text. */
export function formatAccuracyReport(report: AccuracyReport): string {
  const lines: string[] = [];
  const examples = `${report.examples} example${report.examples === 1 ? "" : "s"}`;
  lines.push(
    `${report.set}: ${examples} · provider ${report.provider} · model ${report.model} · score tolerance ${report.tolerance}`,
    "",
  );
  const rows: string[][] = [["question", "correct", "accuracy"]];
  for (const [key, c] of Object.entries(report.questions)) rows.push([key, `${c.correct}/${c.total}`, pct(c)]);
  rows.push(["overall", `${report.overall.correct}/${report.overall.total}`, pct(report.overall)]);
  lines.push(...table(rows), "");
  if (report.wrong.length === 0) {
    lines.push("No wrong answers.");
  } else {
    lines.push(`Wrong answers (${report.wrong.length}):`, ...table(report.wrong.map(wrongRow), "  "));
  }
  return `${lines.join("\n")}\n`;
}

/** Runs `decidekit test`. Returns the exit code; throws on errors. */
export async function testCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        provider: { type: "string" },
        model: { type: "string" },
        tolerance: { type: "string" },
        "min-accuracy": { type: "string" },
        "max-input-chars": { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error), COMMAND);
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    deps.stdout(`${TEST_USAGE}\n`);
    return 0;
  }
  if (positionals.length < 2) {
    const missing = positionals.length === 0 ? "the question set and the labelled examples file" : "the labelled examples file";
    throw new CliUsageError(`missing ${missing}`, COMMAND);
  }
  if (positionals.length > 2) throw new CliUsageError(`too many arguments: ${positionals.slice(2).join(" ")}`, COMMAND);

  const [setPath, examplesPath] = positionals as [string, string];
  const providerName = parseProviderName(values.provider, COMMAND);
  const tolerance = parseNonNegative(values.tolerance, "--tolerance") ?? 0;
  const minAccuracy = parseNonNegative(values["min-accuracy"], "--min-accuracy", 100);
  const maxInputChars = parsePositiveInt(values["max-input-chars"], "--max-input-chars", COMMAND);
  const model = resolveModel(providerName, values.model, deps.env);

  const set = await loadQuestionSet(setPath);
  let text: string;
  try {
    text = await deps.readFile(examplesPath);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
    const reason = code === "ENOENT" ? "file not found" : error instanceof Error ? error.message : String(error);
    throw new CliError(`cannot read examples file "${examplesPath}": ${reason}`);
  }
  const examples = parseExamples(text, set, examplesPath);
  const provider = deps.createProvider(providerName, { model });

  const report = await measureAccuracy({
    provider,
    set,
    examples,
    tolerance,
    ...(maxInputChars === undefined ? {} : { maxInputChars }),
  });

  deps.stdout(values.json === true ? `${JSON.stringify(report, null, 2)}\n` : formatAccuracyReport(report));

  if (minAccuracy !== undefined) {
    const overall = (report.overall.accuracy ?? 0) * 100;
    // Small epsilon: 29 of 100 is 28.999999999999996% in floating point.
    if (overall + 1e-9 < minAccuracy) {
      deps.stderr(`decidekit test: overall accuracy ${overall.toFixed(1)}% is below --min-accuracy ${minAccuracy}%\n`);
      return 1;
    }
  }
  return 0;
}
