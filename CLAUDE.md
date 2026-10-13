# decidekit

decidekit is a free, open-source TypeScript library and CLI that turns any LLM into a typed decision engine. Developers define questions with fixed answer types (`boolean`, `choice`, `score`) in YAML files or inline in TypeScript. decidekit sends the text and questions to Claude (Anthropic API) or a local Ollama model using plain `fetch` (no vendor SDKs), validates each answer against its type, and can measure accuracy against labelled examples. Answers include a `confidence` field: the model's own estimate, which is uncalibrated. Always describe it that way.

## Commands
- Install: `npm install`
- Test: `npm test` (Vitest, single run). Watch mode: `npm run test:watch`
- Type-check: `npm run typecheck` (checks `src/`, `tests/` and `vitest.config.ts`)
- Build: `npm run build` (compiles `src/` to `dist/` using `tsconfig.build.json`)
- Run the CLI after building: `node dist/cli.js --help`

## Project structure
- `src/`: library and CLI source. `index.ts` is the public API entry point and `cli.ts` is the `decidekit` bin, which keeps its `#!/usr/bin/env node` shebang.
- `tests/`: Vitest tests, named `*.test.ts`. Put test data in `tests/fixtures/`.
- `examples/`: runnable example question sets and labelled examples (R-7).
- `docs/`: user documentation (R-8).
- `dist/`: build output. Git-ignored, so never edit it by hand.

## How we build here
- Stack: TypeScript (strict), Node >=22, ESM (`"type": "module"`), compiled with `tsc`, tested with Vitest. It's a small, standard toolchain with no bundler and no `tsx`.
- Imports: ESM with explicit `.js` extensions on relative imports (`import { x } from "./foo.js"`), including in tests. Use `node:` prefixes for built-ins and `import type` for type-only imports (`verbatimModuleSyntax` is on).
- Strictness: `strict` and `noUncheckedIndexedAccess` are on. Don't use `any` or `@ts-ignore` unless a comment explains why.
- HTTP: providers call the APIs with the global `fetch`. Don't add vendor SDKs.
- CLI: keep the logic in pure, testable functions (see `main()` in `src/cli.ts`). The shell-facing code only writes output and sets the exit code.
- Errors: throw clear `Error`s that say what was wrong and where (for example, the file and question id). Never swallow errors silently.
- Tests: every change comes with tests in `tests/`. **No real network calls in tests.** Mock `fetch` (for example with `vi.stubGlobal("fetch", ...)`) and restore it afterwards.
- Data: use test fixtures only, never real personal data.
- Secrets: the Anthropic API key comes from the environment (`ANTHROPIC_API_KEY`) at runtime. Never print, log or echo API keys, including in error messages. Don't load `.env` files (no dotenv) and never read, create or commit `.env`.
- Dependencies: approved packages only. Runtime: `yaml`. Dev: `typescript`, `vitest`, `@types/node`. Ask before adding anything else.
- Git: this folder is its own repository. Don't commit or push unless the user asks.

## Definition of done
- `npm test`, `npm run typecheck` and `npm run build` all pass.
- New behaviour is covered by tests that make no real network calls.
- README and docs are updated when user-facing behaviour changes.
- No secrets in code, logs or git. Nothing beyond the approved dependencies.

## Working with Rumi's agent team
This project is built with the rumi-team plugin. Requirements are cards (R-1, R-2, …) on the Agent Team Board. Agents change only what their card needs, use test data, and stop to ask (through Needs you) before installing packages, touching data or contacting external services.
