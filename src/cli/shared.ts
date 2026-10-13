/**
 * Shared CLI plumbing: injectable dependencies, provider creation, usage
 * errors, input reading and error formatting. Used by every subcommand.
 */
import { readFile } from "node:fs/promises";
import { ProviderError } from "../errors.js";
import type { Provider } from "../provider.js";
import { QuestionSetError } from "../questionSet.js";
import { anthropicProvider } from "../providers/anthropic.js";
import { ollamaProvider } from "../providers/ollama.js";

/** The providers the CLI can create. */
export const PROVIDER_NAMES = ["anthropic", "ollama"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** Default Ollama model when neither `--model` nor `DECIDEKIT_OLLAMA_MODEL` is set. */
export const OLLAMA_CLI_DEFAULT_MODEL = "llama3.2";

/** Options passed to {@link CliDeps.createProvider}. */
export interface CreateProviderOptions {
  /** Model id. For anthropic, undefined means the provider's own default. */
  readonly model?: string | undefined;
}

/** Everything the CLI touches in the outside world, so tests can replace it. */
export interface CliDeps {
  /** Writes to standard output (the text should include its own newlines). */
  readonly stdout: (text: string) => void;
  /** Writes to standard error (the text should include its own newlines). */
  readonly stderr: (text: string) => void;
  /** Reads all of standard input as UTF-8 text. */
  readonly readStdin: () => Promise<string>;
  /** Reads a file as UTF-8 text. */
  readonly readFile: (path: string) => Promise<string>;
  /** Creates a provider by name. May throw (for example when an API key is missing). */
  readonly createProvider: (name: ProviderName, options: CreateProviderOptions) => Provider;
  /** Environment variables. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Creates the real providers. Construction makes no network call. */
export function defaultCreateProvider(name: ProviderName, options: CreateProviderOptions): Provider {
  if (name === "ollama") {
    return ollamaProvider({ model: options.model ?? OLLAMA_CLI_DEFAULT_MODEL });
  }
  return anthropicProvider({ model: options.model });
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The real-world dependencies used by the `decidekit` bin. */
export function defaultDeps(): CliDeps {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    readStdin: readAllStdin,
    readFile: (path) => readFile(path, "utf8"),
    createProvider: defaultCreateProvider,
    env: process.env,
  };
}

/**
 * A problem with the command line itself (bad or missing arguments). The CLI
 * prints the message plus a hint to run `--help`.
 */
export class CliUsageError extends Error {
  override readonly name = "CliUsageError";
  /** The subcommand whose help to suggest, if any. */
  readonly command: string | undefined;

  constructor(message: string, command?: string) {
    super(message);
    this.command = command;
  }
}

/** A runtime problem with a clear message (missing file, empty input). */
export class CliError extends Error {
  override readonly name = "CliError";
}

/** Checks a `--provider` value. */
export function parseProviderName(value: string | undefined, command: string): ProviderName {
  if (value === undefined) return "anthropic";
  if ((PROVIDER_NAMES as readonly string[]).includes(value)) return value as ProviderName;
  throw new CliUsageError(`unknown provider "${value}"; use one of: ${PROVIDER_NAMES.join(", ")}`, command);
}

/** Parses a positive whole-number option such as `--max-input-chars`. */
export function parsePositiveInt(value: string | undefined, flag: string, command: string): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) {
    throw new CliUsageError(`${flag} must be a positive whole number, got "${value}"`, command);
  }
  return Number(trimmed);
}

/** Resolves the model to request for a provider, applying CLI-level defaults. */
export function resolveModel(
  provider: ProviderName,
  model: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const given = model !== undefined && model.trim() !== "" ? model : undefined;
  if (provider === "ollama") {
    const fromEnv = env["DECIDEKIT_OLLAMA_MODEL"];
    return given ?? (fromEnv !== undefined && fromEnv.trim() !== "" ? fromEnv : OLLAMA_CLI_DEFAULT_MODEL);
  }
  return given;
}

function fileErrorReason(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
  if (code === "ENOENT") return "file not found";
  if (code === "EISDIR") return "it is a directory, not a file";
  if (code === "EACCES") return "permission denied";
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the text to analyse from a file, or from stdin when `file` is `-`.
 * Throws a {@link CliError} if it cannot be read or is empty.
 */
export async function readInputText(file: string, deps: CliDeps): Promise<string> {
  let text: string;
  const label = file === "-" ? "stdin" : `input file "${file}"`;
  try {
    text = file === "-" ? await deps.readStdin() : await deps.readFile(file);
  } catch (error) {
    throw new CliError(`cannot read ${label}: ${fileErrorReason(error)}`);
  }
  if (text.trim() === "") {
    throw new CliError(`${label} is empty; give it the text to analyse`);
  }
  const notText = binaryReason(text);
  if (notText !== undefined) {
    throw new CliError(`${label} does not look like text (${notText}); give it UTF-8 text`);
  }
  return text;
}

/**
 * Share of U+FFFD replacement characters above which input is treated as
 * binary. Decoding a non-UTF-8 file as UTF-8 produces one for every invalid
 * byte sequence; real text has few or none.
 */
export const MAX_REPLACEMENT_CHAR_RATIO = 0.1;

/**
 * Says why decoded input looks binary rather than text, or returns
 * `undefined` if it looks like text: it contains a NUL byte, or more than
 * {@link MAX_REPLACEMENT_CHAR_RATIO} of its characters are U+FFFD.
 */
export function binaryReason(text: string): string | undefined {
  if (text.includes("\u0000")) return "it contains NUL bytes";
  let replacements = 0;
  for (const ch of text) if (ch === "\uFFFD") replacements++;
  const length = [...text].length;
  if (replacements > 0 && replacements / length > MAX_REPLACEMENT_CHAR_RATIO) {
    return "it is not valid UTF-8";
  }
  return undefined;
}

/** Collapses an error message onto one line. */
export function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

/** The library's missing-key message starts like this. */
const MISSING_ANTHROPIC_KEY = /^anthropic: no API key\b/;

/** The CLI's version of the missing-key message (the library's mentions an `apiKey` option the CLI doesn't have). */
export const CLI_MISSING_KEY_MESSAGE =
  "anthropic: no API key; set the ANTHROPIC_API_KEY environment variable, or use --provider ollama to run a local model";

function fsCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
}

/**
 * The message for any error thrown while running a command. A few library
 * errors are reworded for the command line: a missing Anthropic key, and a
 * question set file that cannot be read. The API key itself is never shown.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof ProviderError && MISSING_ANTHROPIC_KEY.test(error.message)) {
    return CLI_MISSING_KEY_MESSAGE;
  }
  if (error instanceof QuestionSetError && typeof fsCode(error.cause) === "string") {
    return `cannot read question set "${error.source}": ${fileErrorReason(error.cause)}`;
  }
  return oneLine(error instanceof Error ? error.message : String(error));
}
