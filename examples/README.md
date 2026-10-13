# Examples

Five ready-made question sets, each with a sample input you can try them on.
All names, companies and text in the samples are fictional.

Each set is a pair of files with the same name:

- `<name>.yaml`: the question set (see [the question set format](../docs/question-set-format.md))
- `<name>.input.txt`: a sample text to run it on

| Set | What it decides | Questions | Sample input |
|-----|-----------------|-----------|--------------|
| [`support-triage.yaml`](support-triage.yaml) | Routes a support email and flags urgency | `urgent` (boolean), `team` (choice: Billing / Technical / Sales / Account), `refund_requested` (boolean), `frustration` (score 1-5) | [`support-triage.input.txt`](support-triage.input.txt): a customer charged twice and locked out |
| [`invoice-check.yaml`](invoice-check.yaml) | Compares an invoice with its purchase order | `amounts_match` (boolean), `issue` (choice: None / Price difference / Quantity difference / Missing PO / Duplicate invoice), `needs_approval` (boolean) | [`invoice-check.input.txt`](invoice-check.input.txt): `PURCHASE ORDER` and `INVOICE` sections |
| [`ai-answer-check.yaml`](ai-answer-check.yaml) | Reviews an AI assistant's answer | `answered_question` (boolean), `contains_dubious_claim` (boolean), `tone` (choice: Helpful / Neutral / Curt / Rude), `quality` (score 1-10) | [`ai-answer-check.input.txt`](ai-answer-check.input.txt): `USER QUESTION:` and `AI ANSWER:` sections |
| [`content-moderation.yaml`](content-moderation.yaml) | Screens a user comment before publishing | `spam` (boolean), `category` (choice: Safe / Harassment / Hate / Self-harm / Sexual / Violence / Other), `needs_human_review` (boolean), `severity` (score 0-3) | [`content-moderation.input.txt`](content-moderation.input.txt): a mildly rude comment with a spam link |
| [`lead-scoring.yaml`](lead-scoring.yaml) | Qualifies an inbound sales enquiry | `serious_buyer` (boolean), `budget_mentioned` (boolean), `company_size` (choice: 1-50 / 51-250 / 251-1000 / 1000+), `priority` (score 1-5) | [`lead-scoring.input.txt`](lead-scoring.input.txt): a pricing and demo request |

All scores are whole numbers (`integer: true`).

## Expected answers for the sample inputs

These are the answers a careful reader would give, so you can check a run at a
glance. Models can differ, especially on scores (treat a score within 1 of the
value below as fine) and on borderline choices.

| Set | Expected answers | Why |
|-----|------------------|-----|
| `support-triage` | `urgent` true, `team` Billing, `refund_requested` true, `frustration` 4 | Nobody can log in and there is a deadline tomorrow; a wrong charge plus a refund request puts it with Billing first; second time writing and a threat to leave. |
| `invoice-check` | `amounts_match` false, `issue` Price difference, `needs_approval` true | Totals are 855.00 vs 888.00 because the toner unit price went from 62.50 to 68.00; quantities and the PO number match. |
| `ai-answer-check` | `answered_question` true, `contains_dubious_claim` true, `tone` Helpful (Neutral is also defensible), `quality` 6 | The boiling advice answers the question, but "97% of chefs agree" is an invented statistic. |
| `content-moderation` | `spam` true, `category` Safe, `needs_human_review` false, `severity` 1 | The promo link and discount code are spam. "This list is lazy" and "did the author even own a plant?" criticise the work, and "anyone with half a brain" is aimed at no one in particular, so the instructions class it as Safe with mild rudeness (severity 1), not Harassment. |
| `lead-scoring` | `serious_buyer` true, `budget_mentioned` true, `company_size` 251-1000, `priority` 5 | Asks for pricing and a demo, says budget of about $30,000 is approved, has about 400 staff and must decide this month. |

## Running an example

```sh
decidekit run examples/support-triage.yaml examples/support-triage.input.txt
```

Swap in any other pair, for example
`decidekit run examples/lead-scoring.yaml examples/lead-scoring.input.txt`.

## Measuring accuracy

`support-triage.examples.yaml` holds twelve hand-labelled emails (billing,
technical, sales and account cases, calm and angry) for `support-triage.yaml`.
Run them all and see per-question accuracy and the wrong answers:

```sh
decidekit test examples/support-triage.yaml examples/support-triage.examples.yaml
```

See [the labelled examples format](../docs/labelled-examples-format.md).

From TypeScript you can load any set with `loadQuestionSet`:

```ts
import { loadQuestionSet } from "decidekit";

const set = await loadQuestionSet("examples/invoice-check.yaml");
```

## Tips for writing your own

- **Be specific.** Vague questions get vague answers. Say exactly when to answer
  `true`, define every choice option, and describe what each score level means.
- **Say how to break ties.** If several choice options could apply, tell the
  model which one wins (see `invoice-check.yaml`).
- **Label multi-part inputs.** When the text has several parts, give each a
  clear heading (`PURCHASE ORDER`, `INVOICE`) and refer to those headings in the
  instructions.
- **Quote options that look like numbers.** YAML reads `1000` as a number and
  `true`/`false` as booleans, so write options such as `"1-50"` or `"1000+"`
  in quotes (see `lead-scoring.yaml`). Words like `yes` and `no` stay text.
