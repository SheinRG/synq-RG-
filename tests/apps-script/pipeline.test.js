import { describe, expect, it } from "vitest";
import { code, completion, createMemoryCrm, fakeClassifier, httpResponse, setUpFakeSpreadsheet } from "./fakes.js";

const { syncConversations, runFollowUpCheck, createSheetCrm, createClassifier, DAY_MS, emptyLead } = code;

const T0 = "2026-10-26T10:00:00.000Z";
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const daysAfter = (iso, days) => new Date(Date.parse(iso) + days * DAY_MS).toISOString();

const PRIYA = { name: "Priya Sharma", company: "Acme", linkedinUrl: "" };
const PRIYA_URL = "https://www.linkedin.com/in/priya-sharma/";

/** Pipeline deps over a fake spreadsheet, with a clock we control and a lock that refuses nesting. */
function setup({ rows = [PRIYA], classifier = fakeClassifier(), rules } = {}) {
  const ss = setUpFakeSpreadsheet(rows);
  const state = { now: T0, locked: false };
  const deps = {
    crm: createSheetCrm(ss),
    classifier,
    rules: rules || { notRepliedAfterMs: 3 * DAY_MS, maxFollowUps: 2 },
    now: () => state.now,
    withLock(fn) {
      if (state.locked) throw new Error("nested lock");
      state.locked = true;
      try {
        return fn();
      } finally {
        state.locked = false;
      }
    },
    log: () => {},
  };
  const leads = ss.getSheetByName("Leads");
  const events = ss.getSheetByName("Events");
  return {
    ss,
    deps,
    state,
    row: (n = 2) => leads.rowObject(n),
    rowCount: () => leads.getLastRow() - 1,
    events: () => events.dump().slice(1).map((r) => ({ leadId: r[1], type: r[2], direction: r[3], from: r[5], to: r[6] })),
    sync(conversations, observedAt = state.now) {
      state.now = observedAt;
      const payload = code.validatePayload({ version: 1, observedAt, conversations }).payload;
      return syncConversations(payload, deps);
    },
  };
}

function convo(overrides = {}) {
  return {
    threadId: "2-PRIYA==",
    name: "Priya Sharma",
    profileUrl: "",
    isGroup: false,
    fresh: true,
    lastMessage: { fromMe: true, text: "Hi Priya, loved your post on hiring. Open to a quick chat?" },
    seen: null,
    messages: [],
    ...overrides,
  };
}

const reply = (text, extra = {}) => convo({ lastMessage: { fromMe: false, text }, ...extra });

describe("sync: Message sent -> Opened -> Replied", () => {
  it("walks the statuses, links the thread and labels the reply", () => {
    const t = setup();

    const r1 = t.sync([convo()], at(0));
    expect(r1).toEqual([{ threadId: "2-PRIYA==", leadId: "L-0001", status: "Message sent", action: "updated" }]);
    expect(t.row()).toMatchObject({
      "Lead ID": "L-0001",
      "Thread ID": "2-PRIYA==",
      Status: "Message sent",
      "Last Message From": "Us",
      "Last Outbound At": at(0),
      Source: "Manual",
    });

    // The thread is open now: full text, Seen marker, profile link.
    const r2 = t.sync([convo({ seen: true, profileUrl: PRIYA_URL })], at(5));
    expect(r2[0]).toMatchObject({ status: "Opened", action: "updated" });
    expect(t.row()).toMatchObject({ Status: "Opened", "Opened At": at(5), "LinkedIn URL": PRIYA_URL });

    const r3 = t.sync([reply("Sure, Tuesday works. What's the pricing?")], at(10));
    expect(r3[0]).toMatchObject({ status: "Replied", action: "updated" });
    expect(t.row()).toMatchObject({
      Status: "Replied",
      "Last Message From": "Lead",
      "Last Inbound At": at(10),
      "Reply Category": "Interested",
      "Reply Summary": "Wants a call",
      "Suggested Follow-up": "Great, Tuesday?",
    });

    expect(t.events().map((e) => [e.type, e.from, e.to])).toEqual([
      ["lead_added", "", "Not contacted"],
      ["outbound_message", "Not contacted", "Message sent"],
      ["read", "Message sent", "Opened"],
      ["inbound_message", "Opened", "Replied"],
    ]);
  });

  it("labels replies outside the lock, after the status is already saved", () => {
    let seenStatus;
    const t = setup({
      classifier: fakeClassifier({
        onClassify: () => {
          expect(t.state.locked).toBe(false);
          seenStatus = t.row().Status;
        },
      }),
    });
    t.sync([reply("Interested!")]);
    expect(seenStatus).toBe("Replied");
  });

  it("gives the model the open thread, or just the latest reply", () => {
    const classifier = fakeClassifier();
    const t = setup({ classifier });
    const messages = [
      { fromMe: true, text: "Hi" },
      { fromMe: false, text: "Hello, tell me more" },
    ];
    t.sync([reply("Hello, tell me more", { messages })], at(0));
    expect(classifier.calls.classify[0][0].thread).toEqual([
      { fromLead: false, text: "Hi" },
      { fromLead: true, text: "Hello, tell me more" },
    ]);
    t.sync([reply("Actually, next month")], at(1));
    expect(classifier.calls.classify[1][0].thread).toEqual([{ fromLead: true, text: "Actually, next month" }]);
    expect(classifier.calls.classify[1][0].lead).toMatchObject({ name: "Priya Sharma", company: "Acme" });
  });

  it("marks the reply Unclassified when the model fails, but still records Replied", () => {
    const classifier = createClassifier({ apiKey: "k", baseUrl: "https://llm", model: "m" }, () => [httpResponse(500, "boom")]);
    const t = setup({ classifier });
    t.sync([reply("Not now, thanks")]);
    expect(t.row()).toMatchObject({ Status: "Replied", "Reply Category": "Unclassified", "Reply Summary": "" });
  });

  it("marks the reply Unclassified when no AI key is set", () => {
    const t = setup({ classifier: createClassifier(null) });
    t.sync([reply("Sure")]);
    expect(t.row()["Reply Category"]).toBe("Unclassified");
  });

  it("keeps the label of a newer reply that arrived while the first was being labelled", () => {
    let calls = 0;
    const classifier = {
      classifyAll(items) {
        calls++;
        if (calls === 1) {
          // While the model thinks about reply 1, reply 2 is synced (and labelled) by another request.
          t.sync([reply("Actually, can you send pricing first?")], at(2));
          return items.map(() => ({ category: "Interested", confidence: 0.9, summary: "old", suggestedReply: "" }));
        }
        return items.map(() => ({ category: "Question", confidence: 0.8, summary: "Asks for pricing", suggestedReply: "Here it is" }));
      },
      draftAll: (items) => items.map(() => ""),
    };
    const t = setup({ classifier });
    t.sync([reply("Sounds great, let's talk")], at(1));
    expect(t.row()).toMatchObject({ "Last Inbound At": at(2), "Reply Category": "Question", "Reply Summary": "Asks for pricing" });
  });
});

describe("sync: dedupe and stale data", () => {
  it("does nothing when the same payload arrives twice", () => {
    const t = setup();
    const payload = [convo({ seen: true })];
    t.sync(payload, at(0));
    const sheet = t.ss.getSheetByName("Leads");
    const before = { writes: sheet.writes, events: t.events().length, row: t.row() };

    const again = t.sync(payload, at(1));
    expect(again[0]).toMatchObject({ action: "unchanged", status: "Opened" });
    expect(sheet.writes).toBe(before.writes);
    expect(t.events()).toHaveLength(before.events);
    expect(t.row()).toEqual(before.row);
  });

  it("does not count the list preview of an already stored full message", () => {
    const t = setup();
    t.sync([convo({ lastMessage: { fromMe: true, text: "Hi Priya, loved your post on hiring. Open to a quick chat? I run a small team" } })], at(0));
    const r = t.sync([convo({ lastMessage: { fromMe: true, text: "Hi Priya, loved your post on hiring. Open to…" } })], at(1));
    expect(r[0].action).toBe("unchanged");
  });

  it("ignores a stale snapshot from a second tab", () => {
    const t = setup();
    t.sync([convo({ lastMessage: { fromMe: true, text: "Hi Priya" } })], at(0));
    t.sync([convo({ lastMessage: { fromMe: true, text: "Following up on my note" } })], at(10));
    // The other tab still shows the first message, read off the page at minute 5.
    const r = t.sync([convo({ lastMessage: { fromMe: true, text: "Hi Priya" }, seen: true, observedAt: at(5) })], at(11));
    expect(r[0]).toMatchObject({ action: "unchanged", status: "Message sent" });
    expect(t.row()).toMatchObject({ "Last Message Snippet": "Following up on my note", "Opened At": "" });
  });

  it("does not re-open Replied for a stale reply older than our newer message", () => {
    const classifier = fakeClassifier();
    const t = setup({ classifier });
    t.sync([reply("Sure")], at(0));
    t.sync([convo({ lastMessage: { fromMe: true, text: "Great, sending an invite" } })], at(10));
    const r = t.sync([reply("Sure", { observedAt: at(5) })], at(11));
    expect(r[0].status).toBe("Message sent");
    expect(classifier.calls.classify).toHaveLength(1);
  });

  it("treats observation times far in the future as now", () => {
    const t = setup();
    t.sync([convo({ observedAt: "2030-01-01T00:00:00.000Z" })], at(0));
    expect(t.row()["Last Outbound At"]).toBe(at(0));
  });
});

describe("sync: matching and auto-add", () => {
  it("auto-adds a fresh conversation with someone not in the sheet", () => {
    const t = setup({ rows: [] });
    const r = t.sync([convo({ name: "New Person", threadId: "2-NEW", fresh: true, profileUrl: "https://www.linkedin.com/in/new/" })]);
    expect(r[0]).toMatchObject({ leadId: "L-0001", action: "added", status: "Message sent" });
    expect(t.row()).toMatchObject({
      Name: "New Person",
      "LinkedIn URL": "https://www.linkedin.com/in/new/",
      "Thread ID": "2-NEW",
      Source: "Auto-added",
      Status: "Message sent",
    });
    expect(t.events().map((e) => e.type)).toEqual(["lead_auto_added", "outbound_message"]);
  });

  it("never auto-adds a conversation read without a name or a message (page not fully loaded)", () => {
    const t = setup({ rows: [] });
    const r = t.sync([
      convo({ name: "", threadId: "2-NONAME", fresh: true }),
      convo({ name: "Someone", threadId: "2-EMPTY", fresh: true, lastMessage: null }),
    ]);
    expect(r.map((x) => x.action)).toEqual(["ignored", "ignored"]);
    expect(t.rowCount()).toBe(0);
  });

  it("fills in a blank name once the conversation is read with one", () => {
    const t = setup({ rows: [] });
    // A row left nameless by an earlier version, linked to its thread.
    t.deps.crm.upsertLead({ ...emptyLead("L-0001"), threadId: "2-RAYYAN", status: "Not contacted", source: "Auto-added" });
    t.sync([convo({ name: "Mohammed Rayyan Qureshi", threadId: "2-RAYYAN", fresh: true, lastMessage: { fromMe: false, text: "Hii" } })]);
    expect(t.row()).toMatchObject({ Name: "Mohammed Rayyan Qureshi", Status: "Replied" });
  });

  it("ignores old conversations with people not in the sheet", () => {
    const t = setup({ rows: [] });
    const r = t.sync([convo({ name: "Old Contact", threadId: "2-OLD", fresh: false })]);
    expect(r[0]).toEqual({ threadId: "2-OLD", leadId: "", status: "", action: "ignored", reason: "not in sheet" });
    expect(t.rowCount()).toBe(0);
  });

  it("treats an unchanged old chat with a lead as history, not a reply", () => {
    const t = setup();
    const r = t.sync([reply("haha see you at the reunion", { fresh: false })], at(0));
    expect(r[0]).toMatchObject({ leadId: "L-0001", status: "Not contacted", action: "updated" });
    expect(t.row()).toMatchObject({
      Status: "Not contacted",
      "Thread ID": "2-PRIYA==",
      "Last Message From": "Lead",
      "Last Message Snippet": "haha see you at the reunion",
      "Reply Category": "",
    });
    expect(t.events().map((e) => e.type)).toEqual(["lead_added"]);
    expect(t.deps.classifier.calls.classify).toEqual([]);

    // The same screen again is a no-op; our first real message moves the lead.
    expect(t.sync([reply("haha see you at the reunion", { fresh: false })], at(1))[0].action).toBe("unchanged");
    t.sync([convo()], at(2));
    expect(t.row().Status).toBe("Message sent");
  });

  it("does not take a starting point once the lead has tracked messages", () => {
    const t = setup();
    t.sync([convo()], at(0));
    // Not fresh (for example after reinstalling the extension), but the row already knows the thread.
    t.sync([reply("Sure, let's talk", { fresh: false })], at(1));
    expect(t.row().Status).toBe("Replied");
  });

  it("ignores group conversations and entries without a thread id", () => {
    const t = setup();
    const r = t.sync([convo({ isGroup: true, fresh: true }), convo({ threadId: "" })]);
    expect(r.map((x) => [x.action, x.reason])).toEqual([
      ["ignored", "group conversation"],
      ["ignored", "missing threadId"],
    ]);
    expect(t.row().Status).toBe("Not contacted");
  });

  it("matches by profile URL and fills the thread id", () => {
    const t = setup({ rows: [{ name: "P. Sharma", linkedinUrl: "https://www.linkedin.com/in/Priya-Sharma" }] });
    const r = t.sync([convo({ profileUrl: PRIYA_URL + "?trk=x", fresh: true })]);
    expect(r[0]).toMatchObject({ leadId: "L-0001", action: "updated" });
    expect(t.row()["Thread ID"]).toBe("2-PRIYA==");
    expect(t.row()["LinkedIn URL"]).toBe("https://www.linkedin.com/in/Priya-Sharma");
    expect(t.rowCount()).toBe(1);
  });

  it("keeps matching by thread id once linked, even if the name changes", () => {
    const t = setup();
    t.sync([convo()], at(0));
    const r = t.sync([reply("Hi!", { name: "Priya S." })], at(1));
    expect(r[0]).toMatchObject({ leadId: "L-0001", status: "Replied" });
  });

  it("does not create a duplicate when the same new conversation appears twice in one payload", () => {
    const t = setup({ rows: [] });
    const c = convo({ name: "New Person", threadId: "2-NEW", fresh: true });
    const r = t.sync([c, c]);
    expect(r.map((x) => x.action)).toEqual(["added", "unchanged"]);
    expect(t.rowCount()).toBe(1);
  });

  it("works with any CRM that has the four calls", () => {
    const crm = createMemoryCrm([{ ...emptyLead("L-0001"), name: "Priya Sharma", status: "Not contacted", source: "Manual" }]);
    const deps = { crm, classifier: fakeClassifier(), rules: code.DEFAULT_RULES, now: () => T0, withLock: (fn) => fn() };
    const payload = code.validatePayload({ version: 1, observedAt: T0, conversations: [reply("Yes please")] }).payload;
    syncConversations(payload, deps);
    expect(crm.rows[0]).toMatchObject({ status: "Replied", threadId: "2-PRIYA==", replyCategory: "Interested" });
    expect(crm.events.map((e) => e.eventType)).toEqual(["inbound_message"]);
  });
});

describe("scheduled check", () => {
  it("drafts follow-ups, counts them when sent, and ends in Not replied", () => {
    const classifier = fakeClassifier({ draft: "Hi Priya, just bumping this up." });
    const t = setup({ classifier });
    let now = T0;
    t.sync([convo({ lastMessage: { fromMe: true, text: "Hi Priya" } })], now);

    t.state.now = daysAfter(now, 2);
    expect(runFollowUpCheck(t.deps)).toMatchObject({ changed: 0, drafted: 0 });
    expect(t.row().Status).toBe("Message sent");

    for (let round = 1; round <= 2; round++) {
      t.state.now = daysAfter(now, 3);
      const summary = runFollowUpCheck(t.deps);
      expect(summary).toMatchObject({ changed: 1, drafted: 1 });
      expect(t.row()).toMatchObject({ Status: "Follow-up due", "Suggested Follow-up": "Hi Priya, just bumping this up." });

      now = daysAfter(now, 3.1);
      t.sync([convo({ lastMessage: { fromMe: true, text: "Follow-up number " + round } })], now);
      expect(t.row()).toMatchObject({ Status: "Message sent", "Follow-up Count": round, "Suggested Follow-up": "" });
    }

    t.state.now = daysAfter(now, 3);
    runFollowUpCheck(t.deps);
    expect(t.row().Status).toBe("Not replied");
    expect(t.events().filter((e) => e.type === "daily_check").map((e) => e.to)).toEqual([
      "Follow-up due",
      "Follow-up due",
      "Not replied",
    ]);
  });

  it("does not write a draft if the lead replied while it was being written", () => {
    const t = setup();
    t.sync([convo()], T0);
    t.deps.classifier = {
      classifyAll: (items) => items.map(() => code.UNCLASSIFIED),
      draftAll(items) {
        t.sync([reply("Sorry, missed this!")], daysAfter(T0, 3.01));
        return items.map(() => "A draft");
      },
    };
    t.state.now = daysAfter(T0, 3);
    runFollowUpCheck(t.deps);
    expect(t.row()).toMatchObject({ Status: "Replied", "Suggested Follow-up": "" });
  });

  it("retries labels that are missing, using the stored snippet", () => {
    const t = setup({ classifier: fakeClassifier() });
    t.sync([convo()], T0);
    // As if an earlier run stopped before labelling.
    t.deps.crm.updateStatus("L-0001", "Replied", { lastInboundAt: at(1), lastMessageSnippet: "Yes, call me", lastMessageFrom: "Lead" });
    runFollowUpCheck(t.deps);
    expect(t.row()["Reply Category"]).toBe("Interested");
    expect(t.deps.classifier.calls.classify[0][0].thread).toEqual([{ fromLead: true, text: "Yes, call me" }]);
  });

  it("picks up new human rows", () => {
    const t = setup({ rows: [PRIYA, { name: "Arjun" }] });
    runFollowUpCheck(t.deps);
    expect([t.row(2).Status, t.row(3).Status]).toEqual(["Not contacted", "Not contacted"]);
    expect(t.row(3)["Lead ID"]).toBe("L-0002");
  });
});
