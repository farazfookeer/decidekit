# Contributing to decidekit

Thanks for helping. decidekit is small on purpose: TypeScript (strict), ESM, compiled with `tsc`, tested with Vitest, with one runtime dependency (`yaml`) and no vendor SDKs. Please keep it that way, and open an issue before adding a dependency.

## Setup

You need Node.js 22.12 or newer.

```sh
git clone <this repository's URL> decidekit
cd decidekit
npm install
npm run build
node dist/cli.js --help
```

You don't need an API key or Ollama to develop: the tests never call a real model.

## Tests and checks

Run all of these before opening a pull request. CI runs the same on Node 22 and 24 (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

```sh
npm run typecheck   # tsc --noEmit over src/, tests/ and vitest.config.ts
npm run build       # compile src/ to dist/
npm test            # vitest run
```

- **Type tests are enforced by `npm run typecheck`, not by `npm test`.** Files such as `tests/decide.types.test.ts` use `expectTypeOf` to check decide()'s inferred types. Vitest runs them but doesn't type-check them, so a wrong type only fails under `tsc`. Always run `npm run typecheck`.
- **Build before testing** if you want the full suite: `tests/package.test.ts` checks the built package (importing `decide` from `"decidekit"` through package.json `"exports"`, running `node dist/cli.js --help`, and the `npm pack` file list). Without `dist/` those tests are skipped with a message. CI always builds first.
- **No real network calls in tests.** Mock `fetch`: pass a fake `fetch` to the provider (preferred, see below) or use `vi.stubGlobal("fetch", ...)` and restore it with `vi.unstubAllGlobals()`. For decide() and CLI tests use the scripted fake in `tests/helpers/fakeProvider.ts`.
- **Real loopback probes are opt-in.** A few QA tests make a real `fetch` to a closed port on `127.0.0.1` to check the "not reachable" errors end to end. They are skipped by default and run only with `DECIDEKIT_QA_LOOPBACK=1 npm test`; each has a mocked-fetch equivalent that always runs.
- Use test fixtures (`tests/fixtures/`) and made-up text only, never real personal data.
- Every change comes with tests. Name test files `*.test.ts` and import with explicit `.js` extensions (`import { decide } from "../src/index.js"`).
- Update the README and `docs/` when user-facing behaviour changes.

The optional smoke scripts (`npm run smoke:anthropic`, `npm run smoke:ollama`) make one real call through `dist/` and need a build first; they aren't part of `npm test` or CI. See [docs/api.md](docs/api.md#smoke-scripts).

## Code conventions

- ESM with explicit `.js` extensions on relative imports, `node:` prefixes for built-ins, `import type` for type-only imports.
- `strict` and `noUncheckedIndexedAccess` are on. No `any` or `@ts-ignore` without a comment explaining why.
- Throw clear errors that say what was wrong and where (file, question key, provider). Never swallow errors.
- CLI logic lives in pure functions that take injectable dependencies (`CliDeps` in `src/cli/shared.ts`), so it can be tested without a terminal, files or network.
- Describe `confidence` and choice `scores` as the model's own, uncalibrated estimates, everywhere.

## Adding a provider

A provider is an object that implements the `Provider` interface from `src/provider.ts`:

```ts
interface Provider {
  readonly name: string;
  readonly model: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>; // { prompt, schema, signal? } -> { text } | { json }
}
```

See [the API reference](docs/api.md#the-provider-interface) for the full contract. To add one to decidekit:

1. **Create `src/providers/<name>.ts`** exporting a factory, for example `fooProvider(options): Provider`, and an options interface. Follow `src/providers/anthropic.ts` and `src/providers/ollama.ts`.
2. **Use plain `fetch`**, no SDKs. Accept a `fetch` option (defaulting to the global `fetch`) so tests can inject a mock instead of touching the network:

   ```ts
   export interface FooProviderOptions {
     readonly model: string;
     readonly fetch?: typeof fetch | undefined;
   }

   export function fooProvider(options: FooProviderOptions): Provider {
     const fetchImpl = options.fetch;
     return {
       name: "foo",
       model: options.model,
       async complete({ prompt, schema, signal }) {
         const res = await (fetchImpl ?? fetch)(URL, { method: "POST", body: JSON.stringify({ prompt, schema }), signal });
         // ...
       },
     };
   }
   ```

3. **Make one model call per `complete()`**, and pass `signal` to `fetch`.
4. **Use the `schema`** for native structured output where the API has it (a tool's input schema, a JSON-schema response format, Ollama's `format`).
5. **Throw `ProviderError`** from `src/errors.ts` for transport problems, with `provider` set and `status` for HTTP failures: `throw new ProviderError("foo: HTTP 503 (server error; try again later)", { provider: "foo", status: 503 })`. Start messages with the provider name and say what to do next. Let aborts (`AbortError`, or the signal's own reason) propagate unchanged.
6. **Return bad model output instead of throwing.** If the model replied but the JSON is wrong or missing, return `{ text }` or `{ json }`; decide() validates it and retries once.
7. **Do validation at construction.** Missing required options, malformed URLs or a missing key should throw when the provider is created, before any call.
8. **Never leak keys.** Keep keys in a closure, never on the returned object. Never put a key in an error message, a log line or an error `cause`: an error from `fetch` may quote request headers or URLs, so attach a sanitised copy as the `cause` (see `sanitiseError` and `redact` in `src/providers/anthropic.ts`) or no cause at all. Read keys only from options or the environment at runtime; never load `.env` files. Reject URLs that embed credentials.
9. **Export it** from `src/index.ts` (the factory and its options type).
10. **Wire it into the CLI** if it should be available there: add the name to `PROVIDER_NAMES` and a branch in `defaultCreateProvider` in `src/cli/shared.ts`, and update the `--provider` help text.
11. **Test it** in `tests/<name>.test.ts` with an injected fake `fetch` that returns scripted `Response` objects. Cover: the request body and headers, structured output, `{ text }` and `{ json }` replies, HTTP errors with `status`, network errors, aborts, malformed envelopes, and (with a distinctive fake key) that the key never appears in any message, `cause` or `util.inspect` output.
12. **Document it** in `docs/api.md` and the README.

## Pull requests

- Keep each pull request to one change, with tests and docs.
- Make sure `npm run typecheck`, `npm run build` and `npm test` pass.
- Never commit secrets, `.env` files or `dist/`.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
