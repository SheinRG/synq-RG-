import { describe, expect, it } from "vitest";
import { code } from "./fakes.js";

const { nextState, snippet, emptyLead, DAY_MS } = code;
const RULES = { notRepliedAfterMs: 3 * DAY_MS, maxFollowUps: 2 };

function lead(overrides = {}) {
  return { ...emptyLead("L-0001"), status: "Not contacted", ...overrides };
}

const T0 = "2026-10-24T10:00:00.000Z";
const T1 = "2026-10-24T10:05:00.000Z";
const T2 = "2026-10-24T10:10:00.000Z";
const daysAfter = (iso, days) => new Date(Date.parse(iso) + days * DAY_MS).toISOString();

const outbound = (at, text = "Hi Priya") => ({ type: "outbound_message", at, messageId: "m", text });
const inbound = (at, text = "Sure, Monday works") => ({ type: "inbound_message", at, messageId: "r", text });

describe("lead row added", () => {
  it("sets Not contacted with no follow-up work", () => {
    const t = nextState(lead({ status: "" }), { type: "lead_added" });
    expect(t.status).toBe("Not contacted");
    expect(t.fieldUpdates).toEqual({ status: "Not contacted" });
    expect(t.effects).toEqual([]);
  });

  it("does nothing for a lead that already has a status", () => {
    const t = nextState(lead({ status: "Opened" }), { type: "lead_added" });
    expect(t.changed).toBe(false);
    expect(t.status).toBe("Opened");
  });
});

describe("outbound message", () => {
  it.each(["Not contacted", "Message sent", "Opened", "Replied", "Not replied"])(
    "moves %s to Message sent and records the message",
    (status) => {
      const t = nextState(lead({ status }), outbound(T0));
      expect(t.status).toBe("Message sent");
      expect(t.fieldUpdates).toMatchObject({
        lastOutboundAt: T0,
        openedAt: "",
        lastMessageSnippet: "Hi Priya",
        lastMessageFrom: "Us",
      });
      expect(t.fieldUpdates.followUpCount).toBeUndefined();
    },
  );

  it("clears Opened At from the previous message", () => {
    const t = nextState(lead({ status: "Opened", lastOutboundAt: T0, openedAt: T1 }), outbound(T2, "Another note"));
    expect(t.fieldUpdates.openedAt).toBe("");
  });

  it("counts a follow-up and clears the draft when the status was Follow-up due", () => {
    const t = nextState(
      lead({ status: "Follow-up due", followUpCount: 1, lastOutboundAt: T0, suggestedFollowUp: "draft" }),
      outbound(T2, "Following up"),
    );
    expect(t.status).toBe("Message sent");
    expect(t.fieldUpdates.followUpCount).toBe(2);
    expect(t.fieldUpdates.suggestedFollowUp).toBe("");
  });

  it("ignores an outbound message older than the latest one (stale snapshot)", () => {
    const t = nextState(lead({ status: "Opened", lastOutboundAt: T2 }), outbound(T0, "old"));
    expect(t.changed).toBe(false);
    expect(t.status).toBe("Opened");
  });

  it("ignores an outbound message the lead already replied after", () => {
    const t = nextState(lead({ status: "Replied", lastOutboundAt: T0, lastInboundAt: T2 }), outbound(T1));
    expect(t.changed).toBe(false);
    expect(t.status).toBe("Replied");
  });
});

describe("read (Seen) for latest outbound", () => {
  it("moves Message sent to Opened and sets Opened At", () => {
    const t = nextState(lead({ status: "Message sent", lastOutboundAt: T0 }), { type: "read", at: T1 });
    expect(t.status).toBe("Opened");
    expect(t.fieldUpdates).toEqual({ status: "Opened", openedAt: T1 });
  });

  it("counts a read seen at the same moment the message was observed", () => {
    const t = nextState(lead({ status: "Message sent", lastOutboundAt: T0 }), { type: "read", at: T0 });
    expect(t.status).toBe("Opened");
  });

  it.each(["Not contacted", "Opened", "Replied", "Follow-up due", "Not replied"])("does nothing when status is %s", (status) => {
    const t = nextState(lead({ status, lastOutboundAt: T0 }), { type: "read", at: T1 });
    expect(t.changed).toBe(false);
    expect(t.status).toBe(status);
  });

  it("ignores a read receipt seen before our latest message was sent", () => {
    const t = nextState(lead({ status: "Message sent", lastOutboundAt: T2 }), { type: "read", at: T1 });
    expect(t.changed).toBe(false);
  });

  it("ignores a read receipt for an older message when the send time is known", () => {
    const t = nextState(lead({ status: "Message sent", lastOutboundAt: T1 }), { type: "read", at: T2, messageSentAt: T0 });
    expect(t.changed).toBe(false);
  });

  it("trusts a known send time over the observation time", () => {
    const t = nextState(lead({ status: "Message sent", lastOutboundAt: T1 }), { type: "read", at: T0, messageSentAt: T1 });
    expect(t.status).toBe("Opened");
  });
});

describe("inbound message from lead", () => {
  it.each(["Not contacted", "Message sent", "Opened", "Follow-up due", "Not replied", "Replied"])(
    "moves %s to Replied and asks for a label",
    (status) => {
      const t = nextState(lead({ status, lastOutboundAt: T0 }), inbound(T1));
      expect(t.status).toBe("Replied");
      expect(t.fieldUpdates).toMatchObject({ lastInboundAt: T1, lastMessageSnippet: "Sure, Monday works", lastMessageFrom: "Lead" });
      expect(t.effects).toEqual(["classify_reply"]);
    },
  );

  it("keeps our newer outbound as the latest turn when an older reply shows up", () => {
    const t = nextState(lead({ status: "Message sent", lastOutboundAt: T2 }), inbound(T1, "late"));
    expect(t.status).toBe("Message sent");
    expect(t.fieldUpdates).toEqual({ lastInboundAt: T1 });
    expect(t.effects).toEqual([]);
  });

  it("ignores an inbound message older than the latest inbound", () => {
    const t = nextState(lead({ status: "Replied", lastOutboundAt: T0, lastInboundAt: T2 }), inbound(T1, "old"));
    expect(t.changed).toBe(false);
  });
});

describe("daily check", () => {
  const sent = (overrides = {}) => lead({ status: "Message sent", lastOutboundAt: T0, ...overrides });

  it.each(["Message sent", "Opened"])("moves %s to Follow-up due after the wait and asks for a draft", (status) => {
    const t = nextState(sent({ status }), { type: "daily_check", now: daysAfter(T0, 3) }, RULES);
    expect(t.status).toBe("Follow-up due");
    expect(t.effects).toEqual(["draft_follow_up"]);
  });

  it("moves to Not replied once follow-ups are used up", () => {
    const t = nextState(sent({ followUpCount: 2 }), { type: "daily_check", now: daysAfter(T0, 4) }, RULES);
    expect(t.status).toBe("Not replied");
    expect(t.effects).toEqual([]);
  });

  it("waits until the threshold has passed", () => {
    const t = nextState(sent(), { type: "daily_check", now: daysAfter(T0, 2.9) }, RULES);
    expect(t.changed).toBe(false);
    expect(t.status).toBe("Message sent");
  });

  it.each(["Not contacted", "Replied", "Follow-up due", "Not replied"])("leaves %s alone", (status) => {
    const t = nextState(sent({ status }), { type: "daily_check", now: daysAfter(T0, 10) }, RULES);
    expect(t.changed).toBe(false);
  });

  it("does nothing when the lead replied after our last message", () => {
    const t = nextState(sent({ status: "Opened", lastInboundAt: T1 }), { type: "daily_check", now: daysAfter(T0, 10) }, RULES);
    expect(t.changed).toBe(false);
  });

  it("does nothing without a recorded outbound time", () => {
    const t = nextState(sent({ lastOutboundAt: "" }), { type: "daily_check", now: daysAfter(T0, 10) }, RULES);
    expect(t.changed).toBe(false);
  });

  it("supports minute based thresholds for the demo", () => {
    const rules = { notRepliedAfterMs: 2 * 60_000, maxFollowUps: 2 };
    expect(nextState(sent(), { type: "daily_check", now: "2026-10-24T10:01:00.000Z" }, rules).changed).toBe(false);
    expect(nextState(sent(), { type: "daily_check", now: "2026-10-24T10:02:00.000Z" }, rules).status).toBe("Follow-up due");
  });
});

describe("full conversation", () => {
  it("walks Message sent, Opened, Follow-up due, Message sent, Replied", () => {
    let l = lead();
    const apply = (e) => {
      const t = nextState(l, e, RULES);
      l = { ...l, ...t.fieldUpdates };
      return t.status;
    };
    expect(apply(outbound(T0, "Hi"))).toBe("Message sent");
    expect(apply({ type: "read", at: T2 })).toBe("Opened");
    expect(apply({ type: "daily_check", now: daysAfter(T0, 3) })).toBe("Follow-up due");
    const t4 = daysAfter(T0, 3.1);
    expect(apply(outbound(t4, "Bumping this"))).toBe("Message sent");
    expect(l.followUpCount).toBe(1);
    // A stale "Seen" from before the follow-up must not mark the follow-up as opened.
    expect(apply({ type: "read", at: T2 })).toBe("Message sent");
    expect(apply(inbound(daysAfter(T0, 3.3), "Yes, let's talk"))).toBe("Replied");
  });

  it("ends in Not replied after the last follow-up goes unanswered", () => {
    let l = lead();
    const apply = (e) => {
      const t = nextState(l, e, RULES);
      l = { ...l, ...t.fieldUpdates };
      return t.status;
    };
    let at = T0;
    apply(outbound(at, "Hi"));
    for (let round = 1; round <= 2; round++) {
      at = daysAfter(at, 3);
      expect(apply({ type: "daily_check", now: at })).toBe("Follow-up due");
      apply(outbound(at, "Follow-up " + round));
      expect(l.followUpCount).toBe(round);
    }
    expect(apply({ type: "daily_check", now: daysAfter(at, 3) })).toBe("Not replied");
  });
});

describe("snippet", () => {
  it("flattens whitespace and keeps the first 100 characters", () => {
    expect(snippet("  hello\n\nthere  ")).toBe("hello there");
    expect(snippet("x".repeat(150))).toHaveLength(100);
  });
});

it("ignores unknown events", () => {
  expect(nextState(lead(), { type: "delivered", at: T0 }).changed).toBe(false);
});
