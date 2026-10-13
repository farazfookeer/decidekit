#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION } from "./index.js";
import { runCommand } from "./cli/run.js";
import { testCommand } from "./cli/test.js";
import { CliUsageError, defaultDeps, errorMessage } from "./cli/shared.js";
import type { CliDeps } from "./cli/shared.js";

export type { CliDeps, CreateProviderOptions, ProviderName } from "./cli/shared.js";

export const HELP = `decidekit ${VERSION}
Turn any LLM into a typed decision engine.

Usage:
  decidekit run <set.yaml> <file|-> [options]
      Answer every question in the set about one text (a file, or - for stdin).
      Multi-part inputs go in one file as labelled sections.
      Options: --provider anthropic|ollama (default anthropic), --model <id>,
               --json, --max-input-chars <n>

  decidekit test <set.yaml> <examples.yaml> [--tolerance <n>] [options]
      Measure accuracy against labelled examples (<set>.examples.yaml):
      per-question and overall accuracy, plus every wrong answer.
      Options: --provider, --model, --json, --min-accuracy <pct>,
               --max-input-chars <n>. Exits 0 when the test ran,
               whatever the accuracy (unless --min-accuracy is not met).

  decidekit --help       Show this help
  decidekit --version    Show the version

Environment:
  ANTHROPIC_API_KEY        Required for the anthropic provider
  DECIDEKIT_MODEL          Claude model override (default claude-haiku-4-5)
  DECIDEKIT_OLLAMA_MODEL   Default Ollama model (default llama3.2)
  OLLAMA_HOST              Ollama server address (default http://localhost:11434)

Run "decidekit run --help" or "decidekit test --help" for details. The
ollama provider needs a running Ollama server.`;

/**
 * CLI dispatcher: takes the arguments after the program name, writes output
 * through `deps`, and resolves to the exit code. It never exits the process.
 */
export async function main(argv: readonly string[], deps: Partial<CliDeps> = {}): Promise<number> {
  const d: CliDeps = { ...defaultDeps(), ...deps };
  const [first, ...rest] = argv;
  if (first === "--version" || first === "-v") {
    d.stdout(`${VERSION}\n`);
    return 0;
  }
  if (first === undefined || first === "--help" || first === "-h") {
    d.stdout(`${HELP}\n`);
    return 0;
  }
  try {
    if (first === "run") return await runCommand(rest, d);
    if (first === "test") return await testCommand(rest, d);
    throw new CliUsageError(`unknown command "${first}"`);
  } catch (error) {
    const prefix = first === "run" || first === "test" ? `decidekit ${first}` : "decidekit";
    d.stderr(`${prefix}: ${errorMessage(error)}\n`);
    if (error instanceof CliUsageError) {
      const hint = error.command === undefined ? "decidekit --help" : `decidekit ${error.command} --help`;
      d.stderr(`Run "${hint}" for usage.\n`);
    }
    return 1;
  }
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    // realpath so it still works when run through the npm bin symlink.
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2));
}
