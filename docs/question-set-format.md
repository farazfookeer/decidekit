# Question set format

A **question set** is a named collection of questions. Each question has a key,
a type, plain-language instructions and some type-specific fields. You can write
a question set as a YAML file or as a plain object in TypeScript.

## Full example

```yaml
name: support-triage
version: 1
description: Route incoming support emails to the right team.
questions:
  urgent:
    type: boolean
    instructions: Does this need a reply today?
  team:
    type: choice
    instructions: Which team should handle it?
    options: [Billing, Technical, Sales, Account]
  frustration:
    type: score
    instructions: How frustrated is the customer?
    min: 1
    max: 5
    integer: true
```

## Top-level fields

| Field         | Required | Type             | Meaning |
|---------------|----------|------------------|---------|
| `name`        | yes      | string           | A short name for the set, for example `support-triage`. Must not be empty. |
| `version`     | no       | string or number | Your own version label, for example `1` or `"2024-06"`. decidekit doesn't interpret it. |
| `description` | no       | string           | What the set is for. |
| `questions`   | yes      | mapping          | The questions, keyed by question key. Must contain at least one question. |

No other top-level fields are allowed, so a typo such as `question:` is
reported instead of being ignored.

## Question keys

Each key under `questions` names a question and becomes the field name in the
result. Keys must match `^[a-z][a-z0-9_]*$`: start with a lowercase letter, then
only lowercase letters, digits and underscores.

- Good: `urgent`, `team`, `frustration_level`, `q2`
- Bad: `Urgent`, `urgent-flag`, `2nd_try`, `_private`

Each key may appear only once. Because `questions` is a YAML mapping, a repeated
key would normally overwrite the earlier one silently. decidekit reports it as
an error instead, along with the line number. The same applies to repeated
fields inside a question (for example two `options:` lines).

## Fields every question has

| Field          | Required | Type   | Meaning |
|----------------|----------|--------|---------|
| `type`         | yes      | string | One of `boolean`, `choice` or `score`. |
| `instructions` | yes      | string | Plain-language instructions telling the model what to decide. Must not be empty. |

Each question type allows only its own fields (listed below). For example,
`options` on a `boolean` question is an error.

## `boolean` questions

A yes/no question. The answer is `true` or `false`. No extra fields.

```yaml
urgent:
  type: boolean
  instructions: Does this need a reply today?
```

## `choice` questions

Pick exactly one option from a fixed list. The answer is one of the options.

| Field     | Required | Type            | Meaning |
|-----------|----------|-----------------|---------|
| `options` | yes      | list of strings | At least 2 options. Each must be a non-empty string, and no option may appear twice. |

```yaml
team:
  type: choice
  instructions: Which team should handle it?
  options: [Billing, Technical, Sales, Account]
```

Options must be strings. YAML reads unquoted numbers such as `42` or `1000` as
numbers, so quote them if you mean text: `options: ["42", "43"]`. decidekit
uses the YAML 1.2 core schema, so `yes`, `no`, `on` and `off` stay strings;
only `true` and `false` are booleans (and `null` or `~` is null). Quoting any
option that could be misread is still a good habit.

## `score` questions

A number between `min` and `max`, inclusive.

| Field     | Required | Type    | Meaning |
|-----------|----------|---------|---------|
| `min`     | yes      | number  | The lowest allowed score. Must be less than `max`. |
| `max`     | yes      | number  | The highest allowed score. |
| `integer` | no       | boolean | When `true`, the score must be a whole number, and `min` and `max` must be whole numbers too. Defaults to allowing decimals. |

```yaml
frustration:
  type: score
  instructions: How frustrated is the customer?
  min: 1
  max: 5
  integer: true
```

## Loading a question set

```ts
import { loadQuestionSet } from "decidekit";

const set = await loadQuestionSet("questions/support-triage.yaml");
console.log(set.questions.team); // { type: "choice", instructions: "...", options: [...] }
```

To check a set you already have as an object (from JSON, say, or written in
TypeScript), use `validateQuestionSet(obj, label)`. To parse YAML text you
already have in memory, use `parseQuestionSet(text, label)`. The `label` is used
in error messages.

## Errors

An invalid set throws a `QuestionSetError`. The message starts with the file
path (or label), then names the question and the problem:

```text
support-triage.yaml: question "team": choice needs at least 2 options
support-triage.yaml: question "frustration": score "min" (5) must be less than "max" (5)
support-triage.yaml: question "urgent": duplicate key: this question is defined more than once (line 6)
support-triage.yaml: question "Urgent-Flag": bad key name: must start with a lowercase letter and contain only lowercase letters, digits and underscores
support-triage.yaml: no questions: "questions" is empty
```

The error also has `source`, `question` and `field` properties, so code can
react to it without parsing the message.
