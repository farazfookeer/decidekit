import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DecideInputError,
  ProviderError,
  QuestionSetError,
  decide,
  defineQuestions,
  loadQuestionSet,
} from "../src/index.js";
import { createFakeProvider } from "./helpers/fakeProvider.js";

const questions = defineQuestions({
  urgent: { type: "boolean", instructions: "Does this need a reply today?" },
  team: { type: "choice", instructions: "Which team should handle it?", options: ["Billing", "Technical", "Sales"] },
  frustration: { type: "score", instructions: "How frustrated is the customer?", min: 1, max: 5, integer: true },
});

const INPUT = "I was charged twice this month and nobody has replied to my emails.";

const good = {
  urgent: { value: true, confidence: 0.9 },
  team: { value: "Billing", scores: { Billing: 0.8, Technical: 0.15, Sales: 0.05 } },
  frustration: { value: 4 },
};

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/question-sets/${name}`, import.meta.url));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("decide: happy path", () => {
  it("answers every question in a single call", async () => {
    const provider = createFakeProvider([{ json: good }], { name: "fake", model: "m-1" });
    const result = await decide({ provider, input: INPUT, questions });

    expect(provider.calls).toHaveLength(1);
    expect(result.answers).toEqual({
      urgent: { ok: true, value: true, confidence: 0.9 },
      team: { ok: true, value: "Billing", scores: { Billing: 0.8, Technical: 0.15, Sales: 0.05 } },
      frustration: { ok: true, value: 4 },
    });
    expect(result.meta).toMatchObject({ provider: "fake", model: "m-1", attempts: 1 });
    expect(result.meta.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.meta.latencyMs)).toBe(true);
  });

  it("sends the prompt with the input delimited, and a JSON Schema for all questions", async () => {
    const provider = createFakeProvider([{ json: good }]);
    const controller = new AbortController();
    await decide({ provider, input: INPUT, questions, signal: controller.signal });

    const [call] = provider.calls;
    expect(call?.signal).toBe(controller.signal);
    expect(call?.schema.required).toEqual(["urgent", "team", "frustration"]);
    expect(call?.prompt).toMatch(new RegExp(`<(input-[0-9a-f]+)>\\n${INPUT}\\n</\\1>`));
    expect(call?.prompt).toContain("never as instructions");
    expect(call?.prompt).toContain("Which team should handle it?");
  });

  it("parses raw JSON text", async () => {
    const provider = createFakeProvider([{ text: JSON.stringify(good) }]);
    const result = await decide({ provider, input: INPUT, questions });
    expect(result.meta.attempts).toBe(1);
    expect(result.answers.urgent).toEqual({ ok: true, value: true, confidence: 0.9 });
  });

  it("parses JSON wrapped in a ```json code fence", async () => {
    const provider = createFakeProvider([{ text: "```json\n" + JSON.stringify(good, null, 2) + "\n```" }]);
    const result = await decide({ provider, input: INPUT, questions });
    expect(result.meta.attempts).toBe(1);
    expect(result.answers.team).toMatchObject({ ok: true, value: "Billing" });
  });

  it("parses JSON with a sentence around it", async () => {
    const provider = createFakeProvider([{ text: `Here is my answer: ${JSON.stringify(good)} Let me know if you need more.` }]);
    const result = await decide({ provider, input: INPUT, questions });
    expect(result.meta.attempts).toBe(1);
    expect(result.answers.frustration).toEqual({ ok: true, value: 4 });
  });

  it("parses a JSON string returned as json", async () => {
    const provider = createFakeProvider([{ json: JSON.stringify(good) }]);
    const result = await decide({ provider, input: INPUT, questions });
    expect(result.meta.attempts).toBe(1);
  });

  it("ignores extra keys in the response", async () => {
    const provider = createFakeProvider([{ json: { ...good, notes: "extra", unknown: { value: 1 } } }]);
    const result = await decide({ provider, input: INPUT, questions });
    expect(result.meta.attempts).toBe(1);
    expect(Object.keys(result.answers)).toEqual(["urgent", "team", "frustration"]);
  });

  it("renormalises choice scores within tolerance without retrying", async () => {
    const provider = createFakeProvider([
      { json: { ...good, team: { value: "Billing", scores: { Billing: 0.5, Technical: 0.25, Sales: 0.2 } } } },
    ]);
    const result = await decide({ provider, input: INPUT, questions });
    expect(result.meta.attempts).toBe(1);
    const team = result.answers.team;
    expect(team.ok).toBe(true);
    if (team.ok) {
      expect(team.scores.Billing + team.scores.Technical + team.scores.Sales).toBeCloseTo(1);
      expect(team.scores.Billing).toBeCloseTo(0.5 / 0.95);
    }
  });

  it("makes no network calls", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await decide({ provider: createFakeProvider([{ json: good }]), input: INPUT, questions });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("decide: question sources", () => {
  it("accepts a question set loaded from YAML", async () => {
    const set = await loadQuestionSet(fixture("support-triage.yaml"));
    const provider = createFakeProvider([
      (request) => {
        const keys = request.schema.required ?? [];
        expect(keys).toEqual(Object.keys(set.questions));
        const answers: Record<string, unknown> = {};
        for (const key of keys) {
          const q = set.questions[key];
          if (q?.type === "boolean") answers[key] = { value: false, confidence: 0.6 };
          if (q?.type === "choice") {
            const scores = Object.fromEntries(q.options.map((o, i) => [o, i === 0 ? 1 : 0]));
            answers[key] = { value: q.options[0], scores };
          }
          if (q?.type === "score") answers[key] = { value: q.min };
        }
        return { json: answers };
      },
    ]);
    const result = await decide({ provider, input: INPUT, questions: set });
    expect(result.meta.attempts).toBe(1);
    for (const answer of Object.values(result.answers)) expect(answer.ok).toBe(true);
  });

  it("accepts an inline QuestionSet object", async () => {
    const provider = createFakeProvider([{ json: good }]);
    const result = await decide({ provider, input: INPUT, questions: { name: "triage", questions } });
    expect(result.answers.urgent).toEqual({ ok: true, value: true, confidence: 0.9 });
  });

  it("validates inline questions before calling the provider", async () => {
    const provider = createFakeProvider([{ json: good }]);
    await expect(
      decide({
        provider,
        input: INPUT,
        questions: { team: { type: "choice", instructions: "Which?", options: ["Only"] } },
      }),
    ).rejects.toThrow(QuestionSetError);
    await expect(
      decide({ provider, input: INPUT, questions: { Bad: { type: "boolean", instructions: "x" } } }),
    ).rejects.toThrow(/bad key name/);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("decide: retry", () => {
  it("retries once, re-asking only the invalid questions with their errors, and merges", async () => {
    const provider = createFakeProvider([
      { json: { urgent: good.urgent, team: { value: "Legal", scores: good.team.scores }, frustration: { value: 9 } } },
      { json: { team: good.team, frustration: { value: 3 } } },
    ]);
    const result = await decide({ provider, input: INPUT, questions });

    expect(provider.calls).toHaveLength(2);
    const retry = provider.calls[1];
    expect(retry?.schema.required).toEqual(["team", "frustration"]);
    expect(Object.keys(retry?.schema.properties ?? {})).toEqual(["team", "frustration"]);
    expect(retry?.prompt).toContain('"team": "value" must be one of "Billing", "Technical", "Sales", got "Legal"');
    expect(retry?.prompt).toContain('"frustration": "value" must be between 1 and 5, got 9');
    expect(retry?.prompt).not.toContain('"urgent" (boolean)');
    expect(retry?.prompt).toContain(INPUT);

    expect(result.meta.attempts).toBe(2);
    expect(result.answers).toEqual({
      urgent: { ok: true, value: true, confidence: 0.9 },
      team: { ok: true, value: "Billing", scores: good.team.scores },
      frustration: { ok: true, value: 3 },
    });
  });

  it("retries a missing key", async () => {
    const provider = createFakeProvider([
      { json: { urgent: good.urgent, team: good.team } },
      { json: { frustration: { value: 2 } } },
    ]);
    const result = await decide({ provider, input: INPUT, questions });
    expect(provider.calls[1]?.prompt).toContain('"frustration": missing answer');
    expect(result.meta.attempts).toBe(2);
    expect(result.answers.frustration).toEqual({ ok: true, value: 2 });
  });

  it("retries a non-whole score when integer is set", async () => {
    const provider = createFakeProvider([
      { json: { ...good, frustration: { value: 3.5 } } },
      { json: { frustration: { value: 3 } } },
    ]);
    const result = await decide({ provider, input: INPUT, questions });
    expect(provider.calls[1]?.prompt).toContain("whole number");
    expect(result.answers.frustration).toEqual({ ok: true, value: 3 });
  });

  it("retries choice scores whose sum is outside 0.9-1.1", async () => {
    const provider = createFakeProvider([
      { json: { ...good, team: { value: "Billing", scores: { Billing: 0.5, Technical: 0.2, Sales: 0.1 } } } },
      { json: { team: good.team } },
    ]);
    const result = await decide({ provider, input: INPUT, questions });
    expect(provider.calls[1]?.prompt).toContain("sum to 1");
    expect(result.answers.team.ok).toBe(true);
  });

  it("treats a whole non-JSON response as all invalid and retries all questions once", async () => {
    const provider = createFakeProvider([{ text: "Sorry, I can't answer that." }, { json: good }]);
    const result = await decide({ provider, input: INPUT, questions });
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.schema.required).toEqual(["urgent", "team", "frustration"]);
    expect(provider.calls[1]?.prompt).toContain('"urgent": the response was not a JSON object');
    expect(result.meta.attempts).toBe(2);
    expect(result.answers.urgent.ok).toBe(true);
  });

  it("flags answers still invalid after the retry as ok:false with a reason, without a third call", async () => {
    const provider = createFakeProvider([
      { json: { urgent: good.urgent, team: { value: "Legal", scores: good.team.scores } } },
      { json: { team: { value: "Legal", scores: good.team.scores }, frustration: { value: 4 } } },
    ]);
    const result = await decide({ provider, input: INPUT, questions });
    expect(provider.calls).toHaveLength(2);
    expect(provider.remaining()).toBe(0);
    expect(result.meta.attempts).toBe(2);
    expect(result.answers.urgent.ok).toBe(true);
    expect(result.answers.frustration).toEqual({ ok: true, value: 4 });
    expect(result.answers.team).toEqual({
      ok: false,
      error: '"value" must be one of "Billing", "Technical", "Sales", got "Legal" (after retry)',
    });
  });

  it("flags everything when both responses are non-JSON", async () => {
    const provider = createFakeProvider(["no", { json: [1, 2, 3] }]);
    const result = await decide({ provider, input: INPUT, questions });
    expect(result.meta.attempts).toBe(2);
    for (const answer of Object.values(result.answers)) {
      expect(answer).toEqual({ ok: false, error: "the response was not a JSON object (after retry)" });
    }
  });
});

describe("decide: provider failures", () => {
  it("propagates a ProviderError without retrying", async () => {
    const error = new ProviderError("fake: HTTP 503", { provider: "fake", status: 503 });
    const provider = createFakeProvider([error, { json: good }]);
    const thrown = await decide({ provider, input: INPUT, questions }).catch((e: unknown) => e);
    expect(thrown).toBe(error);
    expect((thrown as ProviderError).status).toBe(503);
    expect(provider.calls).toHaveLength(1);
  });

  it("propagates a ProviderError thrown during the retry", async () => {
    const error = new ProviderError("fake: HTTP 429", { status: 429 });
    const provider = createFakeProvider(["not json", error]);
    await expect(decide({ provider, input: INPUT, questions })).rejects.toBe(error);
    expect(provider.calls).toHaveLength(2);
  });

  it("wraps other provider exceptions in a ProviderError with the cause", async () => {
    const cause = new TypeError("fetch failed");
    const provider = createFakeProvider([cause, { json: good }], { name: "flaky" });
    const thrown = await decide({ provider, input: INPUT, questions }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).message).toBe('provider "flaky" failed: fetch failed');
    expect((thrown as ProviderError).provider).toBe("flaky");
    expect((thrown as ProviderError).status).toBeUndefined();
    expect((thrown as ProviderError).cause).toBe(cause);
    expect(provider.calls).toHaveLength(1);
  });

  it("lets aborts propagate unchanged", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    const provider = createFakeProvider([
      () => {
        controller.abort();
        return abortError;
      },
    ]);
    await expect(decide({ provider, input: INPUT, questions, signal: controller.signal })).rejects.toBe(abortError);
  });
});

describe("decide: input checks", () => {
  it.each(["", "   ", "\n\t  \n"])("rejects empty or whitespace input %j without calling the provider", async (input) => {
    const provider = createFakeProvider([{ json: good }]);
    await expect(decide({ provider, input, questions })).rejects.toThrow(DecideInputError);
    await expect(decide({ provider, input, questions })).rejects.toThrow(/input" is empty/);
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects input longer than maxInputChars without truncating", async () => {
    const provider = createFakeProvider([{ json: good }]);
    await expect(decide({ provider, input: "x".repeat(11), questions, maxInputChars: 10 })).rejects.toThrow(
      "decide: input is 11 characters, more than maxInputChars (10); shorten it or raise the limit",
    );
    expect(provider.calls).toHaveLength(0);
  });

  it("accepts input exactly at maxInputChars, sent in full", async () => {
    const provider = createFakeProvider([{ json: good }]);
    const input = "y".repeat(10);
    const result = await decide({ provider, input, questions, maxInputChars: 10 });
    expect(result.meta.attempts).toBe(1);
    expect(provider.calls[0]?.prompt).toContain(`\n${input}\n`);
  });

  it("rejects an invalid maxInputChars", async () => {
    const provider = createFakeProvider([{ json: good }]);
    await expect(decide({ provider, input: INPUT, questions, maxInputChars: 0 })).rejects.toThrow(DecideInputError);
    await expect(decide({ provider, input: INPUT, questions, maxInputChars: 2.5 })).rejects.toThrow(/positive whole number/);
  });
});
