/**
 * Type-level tests for decide()'s inferred result types. The assertions are
 * checked by `npm run typecheck` (tsc covers tests/); the runtime part just
 * makes sure the calls work.
 */
import { describe, expectTypeOf, it } from "vitest";
import { decide, defineQuestions } from "../src/index.js";
import type {
  AnswerValue,
  BooleanAnswer,
  ChoiceAnswer,
  DecideResult,
  FailedAnswer,
  QuestionSet,
  ScoreAnswer,
} from "../src/index.js";
import { createFakeProvider } from "./helpers/fakeProvider.js";

const good = {
  urgent: { value: true, confidence: 0.9 },
  team: { value: "Billing", scores: { Billing: 0.9, Technical: 0.1 } },
  frustration: { value: 2 },
};

describe("decide: inferred types", () => {
  it("infers answer types from questions written inline in the call", async () => {
    const result = await decide({
      provider: createFakeProvider([{ json: good }]),
      input: "text",
      questions: {
        urgent: { type: "boolean", instructions: "Urgent?" },
        team: { type: "choice", instructions: "Team?", options: ["Billing", "Technical"] },
        frustration: { type: "score", instructions: "1-5", min: 1, max: 5 },
      },
    });

    const { urgent, team, frustration } = result.answers;
    expectTypeOf(urgent).toEqualTypeOf<BooleanAnswer | FailedAnswer>();
    expectTypeOf(team).toEqualTypeOf<ChoiceAnswer<"Billing" | "Technical"> | FailedAnswer>();
    expectTypeOf(frustration).toEqualTypeOf<ScoreAnswer | FailedAnswer>();

    if (urgent.ok) {
      expectTypeOf(urgent.value).toEqualTypeOf<boolean>();
      expectTypeOf(urgent.confidence).toEqualTypeOf<number>();
    } else {
      expectTypeOf(urgent.error).toEqualTypeOf<string>();
    }
    if (team.ok) {
      expectTypeOf(team.value).toEqualTypeOf<"Billing" | "Technical">();
      expectTypeOf(team.scores).toEqualTypeOf<Readonly<Record<"Billing" | "Technical", number>>>();
    }
    if (frustration.ok) expectTypeOf(frustration.value).toEqualTypeOf<number>();

    // Only declared keys exist.
    expectTypeOf(result.answers).not.toHaveProperty("other");
    expectTypeOf(result.meta.attempts).toEqualTypeOf<number>();
  });

  it("infers answer types from defineQuestions()", async () => {
    const questions = defineQuestions({
      urgent: { type: "boolean", instructions: "Urgent?" },
      team: { type: "choice", instructions: "Team?", options: ["Billing", "Technical"] },
      frustration: { type: "score", instructions: "1-5", min: 1, max: 5, integer: true },
    });
    const result = await decide({ provider: createFakeProvider([{ json: good }]), input: "text", questions });

    expectTypeOf<AnswerValue<typeof questions.urgent>>().toEqualTypeOf<boolean>();
    expectTypeOf<AnswerValue<typeof questions.team>>().toEqualTypeOf<"Billing" | "Technical">();
    expectTypeOf<AnswerValue<typeof questions.frustration>>().toEqualTypeOf<number>();

    const team = result.answers.team;
    if (team.ok) expectTypeOf(team.value).toEqualTypeOf<"Billing" | "Technical">();
    const urgent = result.answers.urgent;
    if (urgent.ok) expectTypeOf(urgent.value).toEqualTypeOf<boolean>();
  });

  it("infers from an inline QuestionSet object", async () => {
    const result = await decide({
      provider: createFakeProvider([{ json: good }]),
      input: "text",
      questions: { name: "triage", questions: defineQuestions({ urgent: { type: "boolean", instructions: "Urgent?" } }) },
    });
    const urgent = result.answers.urgent;
    if (urgent.ok) expectTypeOf(urgent.value).toEqualTypeOf<boolean>();
  });

  it("falls back to the general union types for a loaded question set", () => {
    // Shape-only check: a loaded set is QuestionSet with general Question values.
    type Loaded = QuestionSet;
    type Result = DecideResult<Loaded["questions"]>;
    type Answer = Result["answers"][string];
    expectTypeOf<Answer>().toEqualTypeOf<BooleanAnswer | ChoiceAnswer<string> | ScoreAnswer | FailedAnswer>();
    expectTypeOf<Extract<Answer, { ok: true }>["value"]>().toEqualTypeOf<boolean | string | number>();

    const call = (set: QuestionSet) =>
      decide({ provider: createFakeProvider([]), input: "text", questions: set });
    expectTypeOf(call).returns.resolves.toEqualTypeOf<DecideResult<Loaded["questions"]>>();
  });
});
