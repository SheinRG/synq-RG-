import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tracking = require("../../extension/tracking.js");
const shared = require("../../extension/shared.js");

function convo(threadId, text, fromMe = true) {
  return {
    threadId,
    threadUrl: "https://www.linkedin.com/messaging/thread/" + threadId + "/",
    name: "Fake " + threadId,
    profileUrl: "",
    isGroup: false,
    fresh: false,
    observedAt: "2026-10-26T10:00:00.000Z",
    lastMessage: { fromMe, text },
    seen: null,
    messages: [],
  };
}

const freshFlags = (result) => Object.fromEntries(result.conversations.map((c) => [c.threadId, c.fresh]));

describe("applyFreshness", () => {
  const firstScan = tracking.applyFreshness([convo("a", "hello a"), convo("b", "hello b")], undefined);

  it("first scan ever records a baseline and marks nothing fresh", () => {
    expect(freshFlags(firstScan)).toEqual({ a: false, b: false });
    expect(firstScan.state.baselineTaken).toBe(true);
  });

  it("does not take the baseline from an empty page", () => {
    const result = tracking.applyFreshness([], undefined);
    expect(result.state.baselineTaken).toBe(false);
  });

  it("an unchanged baseline conversation stays not fresh", () => {
    const result = tracking.applyFreshness([convo("a", "hello a"), convo("b", "hello b")], firstScan.state);
    expect(freshFlags(result)).toEqual({ a: false, b: false });
  });

  it("a baseline conversation with a new last message becomes fresh, and stays fresh", () => {
    const changed = tracking.applyFreshness([convo("a", "they replied", false), convo("b", "hello b")], firstScan.state);
    expect(freshFlags(changed)).toEqual({ a: true, b: false });
    const later = tracking.applyFreshness([convo("a", "they replied", false), convo("b", "hello b")], changed.state);
    expect(freshFlags(later)).toEqual({ a: true, b: false });
  });

  it("a new conversation at the top is fresh", () => {
    const result = tracking.applyFreshness([convo("new", "hi new"), convo("a", "hello a")], firstScan.state);
    expect(freshFlags(result)).toEqual({ new: true, a: false });
  });

  it("an unknown conversation below an unchanged baseline one is old (scrolled into view)", () => {
    const result = tracking.applyFreshness([convo("a", "hello a"), convo("old", "from 2024")], firstScan.state);
    expect(freshFlags(result)).toEqual({ a: false, old: false });
    // ...and if it changes later, it becomes fresh like any baseline item.
    const later = tracking.applyFreshness([convo("old", "new reply", false), convo("a", "hello a")], result.state);
    expect(freshFlags(later)).toEqual({ old: true, a: false });
  });

  it("does not mutate the input state", () => {
    const state = JSON.parse(JSON.stringify(firstScan.state));
    tracking.applyFreshness([convo("a", "changed")], state);
    expect(state).toEqual(firstScan.state);
  });
});

describe("rememberThreads", () => {
  // A list item as the parser returns it: no thread id unless it is open.
  function item(name, text, extra = {}) {
    return {
      ...convo("", text),
      threadUrl: "",
      name,
      key: name.toLowerCase(),
      ambiguous: false,
      ...extra,
    };
  }
  const open = (name, threadId, text, fromMe = true) =>
    item(name, text, { threadId, threadUrl: "u", messages: [{ fromMe, text }], lastMessage: { fromMe, text } });

  it("learns a thread id while the thread is open and uses it once it is closed", () => {
    const first = tracking.rememberThreads([open("Ana Fake", "2-ANA", "hi"), item("Ben Fake", "yo")], undefined);
    expect(first.conversations.map((c) => c.threadId)).toEqual(["2-ANA", ""]);

    const later = tracking.rememberThreads([item("Ana Fake", "hi"), item("Ben Fake", "yo")], first.memory);
    expect(later.conversations[0]).toMatchObject({
      threadId: "2-ANA",
      threadUrl: "https://www.linkedin.com/messaging/thread/2-ANA/",
    });
    expect(later.conversations[1].threadId).toBe("");
  });

  it("never learns or looks up a name shown twice in the list", () => {
    const memory = { ids: { "gus twin": "2-OLD" }, senders: {} };
    const result = tracking.rememberThreads(
      [open("Gus Twin", "2-NEW", "a", true), item("Gus Twin", "b", { key: "gus twin#2" })].map((c) => ({ ...c, ambiguous: true })),
      memory,
    );
    expect(result.conversations.map((c) => c.threadId)).toEqual(["2-NEW", ""]);
    expect(result.memory.ids["gus twin"]).toBe("2-OLD");
  });

  it("keeps who sent the last message, as the thread showed it, while the preview is unchanged", () => {
    // A message with a subject line: the preview shows the subject with no "You:".
    const first = tracking.rememberThreads([open("Ana Fake", "2-ANA", "Applying for the intern role", true)], undefined);
    const closed = item("Ana Fake", "Applying for the intern role", { lastMessage: { fromMe: false, text: "Applying for the intern role" } });
    const later = tracking.rememberThreads([closed], first.memory);
    expect(later.conversations[0].lastMessage).toEqual({ fromMe: true, text: "Applying for the intern role" });

    // A new preview is a new message: the list's reading is used again.
    const replied = item("Ana Fake", "Sure, let's talk", { lastMessage: { fromMe: false, text: "Sure, let's talk" } });
    expect(tracking.rememberThreads([replied], first.memory).conversations[0].lastMessage.fromMe).toBe(false);
  });

  it("does not mutate its inputs", () => {
    const memory = { ids: {}, senders: {} };
    const conversations = [open("Ana Fake", "2-ANA", "hi")];
    const copy = JSON.parse(JSON.stringify(conversations));
    tracking.rememberThreads(conversations, memory);
    expect(memory).toEqual({ ids: {}, senders: {} });
    expect(conversations).toEqual(copy);
  });
});

describe("freshness by name", () => {
  it("baselines conversations whose thread id is not known yet, and keeps them baselined once it is", () => {
    const withoutId = { ...convo("", "old chat"), key: "ana fake" };
    const first = tracking.applyFreshness([withoutId], undefined);
    const withId = { ...convo("2-ANA", "old chat"), key: "ana fake" };
    expect(tracking.applyFreshness([withId], first.state).conversations[0].fresh).toBe(false);
  });
});

describe("changed-only diffing", () => {
  it("sends everything the first time, then only what changed", () => {
    const first = [convo("a", "one"), convo("b", "two")];
    expect(tracking.pickChanged(first, {})).toHaveLength(2);
    const sent = tracking.markSent({}, first);

    const second = [convo("a", "one"), convo("b", "two, edited")];
    second[0].observedAt = "2026-10-26T11:00:00.000Z"; // a new scan time alone is not a change
    expect(tracking.pickChanged(second, sent).map((c) => c.threadId)).toEqual(["b"]);
  });

  it("treats a change in seen or fresh as a change", () => {
    const sent = tracking.markSent({}, [convo("a", "one")]);
    expect(tracking.pickChanged([{ ...convo("a", "one"), seen: true }], sent)).toHaveLength(1);
    expect(tracking.pickChanged([{ ...convo("a", "one"), fresh: true }], sent)).toHaveLength(1);
  });
});

describe("buildPayload", () => {
  it("has the contract shape and caps conversations at 200", () => {
    const many = Array.from({ length: 250 }, (_, i) => convo("t" + i, "x"));
    const payload = tracking.buildPayload(many, "2026-10-26T10:00:00.000Z");
    expect(payload.version).toBe(1);
    expect(payload.observedAt).toBe("2026-10-26T10:00:00.000Z");
    expect(payload.conversations).toHaveLength(200);
  });

  it("leaves out the extension's own bookkeeping fields", () => {
    const payload = tracking.buildPayload([{ ...convo("a", "x"), key: "fake a", ambiguous: false }], "2026-10-26T10:00:00.000Z");
    expect(payload.conversations[0]).not.toHaveProperty("key");
    expect(payload.conversations[0]).not.toHaveProperty("ambiguous");
  });
});

describe("shared helpers", () => {
  it("accepts Apps Script web app URLs only", () => {
    expect(shared.isValidScriptUrl("https://script.google.com/macros/s/AKfycbx_Fake-Id123/exec")).toBe(true);
    expect(shared.isValidScriptUrl("  https://script.google.com/macros/s/AKfycbx/exec  ")).toBe(true);
    expect(shared.isValidScriptUrl("https://script.google.com/a/macros/example.com/s/AKfycbx/exec")).toBe(true);
    expect(shared.isValidScriptUrl("https://script.google.com/macros/s/AKfycbx/dev")).toBe(false);
    expect(shared.isValidScriptUrl("http://script.google.com/macros/s/AKfycbx/exec")).toBe(false);
    expect(shared.isValidScriptUrl("https://evil.example.com/macros/s/AKfycbx/exec")).toBe(false);
    expect(shared.isValidScriptUrl("")).toBe(false);
    expect(shared.isValidScriptUrl(undefined)).toBe(false);
  });

  it("counts results per action", () => {
    const results = [{ action: "updated" }, { action: "added" }, { action: "updated" }, { action: "ignored" }, { action: "weird" }];
    expect(shared.summarizeResults(results)).toEqual({ updated: 2, unchanged: 0, added: 1, ignored: 1 });
    expect(shared.summarizeResults(undefined)).toEqual({ updated: 0, unchanged: 0, added: 0, ignored: 0 });
  });

  it("retries failed conversations, keeping only the newest reading per thread", () => {
    const pending = [convo("a", "old a"), convo("b", "old b")];
    const merged = shared.mergePending(pending, [convo("a", "new a")]);
    expect(merged.map((c) => [c.threadId, c.lastMessage.text])).toEqual([
      ["b", "old b"],
      ["a", "new a"],
    ]);
    expect(shared.mergePending(undefined, [convo("c", "x")])).toHaveLength(1);
  });
});
