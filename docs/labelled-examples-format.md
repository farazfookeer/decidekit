# Labelled examples format

A **labelled examples file** is a list of texts together with the answers you
expect a question set to give for each one. `decidekit test` runs every example
through the model and reports how often it got the answers right, so you can
see whether your instructions (or a different model) are good enough.

By convention the file sits next to its question set and is named
`<set>.examples.yaml`, for example `support-triage.examples.yaml` for
`support-triage.yaml`.

## Example

```yaml
description: Hand-labelled support emails.   # optional
examples:
  - id: double-charge          # optional
    input: |
      I've been charged twice this month. Please refund one of the payments.
    expected:
      urgent: true
      team: Billing
      refund_requested: true
      frustration: 3
  - input: |
      Could you send me a copy of last month's invoice? No rush.
    expected:
      team: Billing             # only team is scored for this example
```

See [`examples/support-triage.examples.yaml`](../examples/support-triage.examples.yaml)
for a full file with twelve examples.

## Fields

Top level:

| Field         | Required | Type   | Meaning |
|---------------|----------|--------|---------|
| `examples`    | yes      | list   | The labelled examples. Must not be empty. |
| `description` | no       | string | What the examples cover. |

No other top-level fields are allowed.

Each example:

| Field      | Required | Type             | Meaning |
|------------|----------|------------------|---------|
| `id`       | no       | string or number | A name used in the report. Without one, the example is called `#1`, `#2`, ... by its position. Ids must be unique. |
| `input`    | yes      | string           | The text to analyse. Must not be empty. Use a YAML block (`\|`) for multi-line text. |
| `expected` | yes      | mapping          | The expected answer for each question you want to score, keyed by question key. At least one key. |

No other fields are allowed in an example.

## Expected values

Each value in `expected` must match the type of its question in the set:

| Question type | Expected value | Example |
|---------------|----------------|---------|
| `boolean`     | `true` or `false` (`yes`/`no` are read as text, not booleans) | `urgent: true` |
| `choice`      | exactly one of the question's options (case matters) | `team: Billing` |
| `score`       | a number between `min` and `max`; a whole number if the question has `integer: true` | `frustration: 4` |

You don't have to label every question. Questions left out of an example's
`expected` are still asked but not scored for that example.

## Validation

The file is checked against the question set when it is loaded, before any
model call. Errors name the file, the example and the key, for example:

```text
support-triage.examples.yaml: example "double-charge": expected "team": "Bills" is not one of the options (Billing, Technical, Sales, Account)
support-triage.examples.yaml: example "#3": expected "priority": no such question in set "support-triage" (questions: urgent, team, refund_requested, frustration)
support-triage.examples.yaml: example "#2": missing "input"
```

Invalid YAML, a missing `examples` list, unknown fields, duplicate ids and
values of the wrong type are all reported this way.

## Running the test

```sh
decidekit test examples/support-triage.yaml examples/support-triage.examples.yaml
```

Options: `--provider anthropic|ollama`, `--model <id>`, `--tolerance <n>`,
`--min-accuracy <pct>`, `--max-input-chars <n>` and `--json`. Run
`decidekit test --help` for details.

### What counts as correct

- **boolean** and **choice**: the answer equals the expected value.
- **score**: the answer is within `--tolerance` of the expected value. The
  default tolerance is `0` (exact). With `--tolerance 1`, an expected `4`
  accepts `3`, `4` or `5`.

  Tip: score questions with subjective levels (like `frustration`) often
  benefit from `--tolerance 1`, because people labelling the same message
  commonly disagree by one level.
- An answer the model never gave validly (shown as `FAILED`, even after
  decide()'s retry) counts as wrong.

### Output

```text
support-triage: 12 examples · provider anthropic · model claude-haiku-4-5 · score tolerance 0

question           correct   accuracy
urgent             11/12     91.7%
team               12/12     100.0%
refund_requested   12/12     100.0%
frustration        8/12      66.7%
overall            43/48     89.6%

Wrong answers (5):
  webhook-launch-tomorrow   urgent        expected true   got false
  charged-after-cancelling  frustration   expected 3      got 4
  ...
```

Per-question accuracy counts only the examples that label that question.
Overall accuracy counts every labelled answer of every example. `--json` prints
the same report as JSON (`questions`, `overall`, `wrong`, with accuracy as a
fraction from 0 to 1, or `null` when nothing was labelled).

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | The test ran. This is **regardless of accuracy**: a 40% score still exits 0. |
| `1`  | Bad arguments, a file that can't be read or is invalid, a provider error (the report names the example), or overall accuracy below `--min-accuracy`. |

To fail a CI job when accuracy drops, add `--min-accuracy`, for example
`--min-accuracy 90`.

Each example costs one model call (two when some answers need a retry), and
examples run one at a time.

## From TypeScript

```ts
import { loadExamples, loadQuestionSet, measureAccuracy, anthropicProvider } from "decidekit";

const set = await loadQuestionSet("examples/support-triage.yaml");
const examples = await loadExamples("examples/support-triage.examples.yaml", set);
const report = await measureAccuracy({ provider: anthropicProvider(), set, examples, tolerance: 1 });
console.log(report.overall.accuracy, report.wrong);
```

`parseExamples(text, set, label)` and `validateExamples(obj, set, label)` work
on YAML text or an already-parsed object, and `isCorrect(question, expected,
answer, tolerance)` scores one answer. Validation errors are `ExamplesError`s.
