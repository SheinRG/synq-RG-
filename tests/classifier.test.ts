import { describe, expect, it } from "vitest";
import { LlmClassifier, UNCLASSIFIED, formatThread, parseJson } from "../src/ai/classifier.js";
import { emptyLead } from "../src/types.js";

const lead = { ...emptyLead("L-0001"), name: "Priya Sharma", company: "Acme Corp" };
const thread = [
  { fromLead: false, text: "Hi Priya, open to a quick chat?", at: "2026-10-24T10:00:00Z" },
  { fromLead: true, text: "Sure, Monday works", at: "2026-10-24T11:00:00Z" },
];

/** A fetch that answers like an OpenAI compatible chat completions endpoint. */
function fakeLlm(content: string | (() => never)): typeof fetch {
  return (async () => {
    if (typeof content === "function") content();
    const body = {
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "test",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const make = (f: typeof fetch) => new LlmClassifier("test-key", "https://llm.invalid/v1", "test-model", { fetch: f });

describe("LlmClassifier", () => {
  it("returns the parsed label", async () => {
    const c = make(
      fakeLlm(
        JSON.stringify({ category: "Interested", confidence: 0.86, summary: "Open to a call Monday", suggested_reply: "Great, does 11am work?" }),
      ),
    );
    expect(await c.classify(lead, thread)).toEqual({
      category: "Interested",
      confidence: 0.86,
      summary: "Open to a call Monday",
      suggestedReply: "Great, does 11am work?",
    });
  });

  it("accepts JSON wrapped in a code fence", async () => {
    const c = make(fakeLlm('```json\n{"category":"Later","confidence":0.7,"summary":"Busy until Q1"}\n```'));
    expect((await c.classify(lead, thread)).category).toBe("Later");
  });

  it("falls back to Unclassified on an unknown category", async () => {
    const c = make(fakeLlm(JSON.stringify({ category: "Maybe", confidence: 0.5, summary: "?" })));
    expect(await c.classify(lead, thread)).toEqual(UNCLASSIFIED);
  });

  it("falls back to Unclassified on invalid JSON", async () => {
    expect(await make(fakeLlm("I think they are interested!")).classify(lead, thread)).toEqual(UNCLASSIFIED);
  });

  it("falls back to Unclassified when the API fails", async () => {
    const failing = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
    expect(await make(failing).classify(lead, thread)).toEqual(UNCLASSIFIED);
  });

  it("returns an empty draft when drafting fails", async () => {
    expect(await make(fakeLlm("nope")).draftFollowUp(lead, thread)).toBe("");
    expect(await make(fakeLlm('{"message":"Any thoughts on this?"}')).draftFollowUp(lead, thread)).toBe("Any thoughts on this?");
  });
});

describe("helpers", () => {
  it("formats the thread oldest first with speaker labels", () => {
    expect(formatThread(lead, thread)).toBe(
      "Lead: Priya Sharma at Acme Corp\n\nConversation (oldest first):\nUs: Hi Priya, open to a quick chat?\nLead: Sure, Monday works",
    );
  });

  it("parses plain and fenced JSON", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });
});
