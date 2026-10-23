import { describe, expect, it } from "vitest";
import { DAY_MS, nextState, snippet, type Rules } from "../src/engine/status.js";
import { emptyLead, type Lead } from "../src/types.js";

const RULES: Rules = { notRepliedAfterMs: 3 * DAY_MS, maxFollowUps: 2 };

function lead(overrides: Partial<Lead> = {}): Lead {
  return { ...emptyLead("L-0001"), status: "Not contacted", providerId: "ACo123", ...overrides };
}

const T0 = "2026-10-24T10:00:00.000Z";
const T1 = "2026-10-24T10:05:00.000Z";
const T2 = "2026-10-24T10:10:00.000Z";
const daysAfter = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY_MS).toISOString();

describe("lead row added", () => {
  it("sets Not contacted and asks to resolve the provider id", () => {
    const t = nextState(lead({ status: "", providerId: "" }), { type: "lead_added" });
    expect(t.status).toBe("Not contacted");
    expect(t.effects).toEqual(["resolve_provider_id"]);
  });

  it("skips provider lookup when the id is already known", () => {
    const t = nextState(lead({ status: "" }), { type: "lead_added" });
    expect(t.effects).toEqual([]);
  });

  it("does nothing for a lead that already has a status", () => {
    const t = nextState(lead({ status: "Opened" }), { type: "lead_added" });
    expect(t.changed).toBe(false);
    expect(t.status).toBe("Opened");
  });
});

describe("outbound message", () => {
  it("moves any status to Message sent and records the time", () => {
    const t = nextState(lead(), { type: "outbound_message", at: T0, messageId: "m1", text: "Hi Priya" });
    expect(t.status).toBe("Message sent");
    expect(t.fieldUpdates).toMatchObject({ lastOutboundAt: T0, openedAt: "", lastMessageSnippet: "Hi Priya" });
    expect(t.fieldUpdates.followUpCount).toBeUndefined();
  });

  it("clears Opened At from the previous message", () => {
    const t = nextState(lead({ status: "Opened", lastOutboundAt: T0, openedAt: T1 }), {
      type: "outbound_message", at: T2, messageId: "m2", text: "Another note",
    });
    expect(t.fieldUpdates.openedAt).toBe("");
  });

  it("counts a follow-up when the previous status was Follow-up due", () => {
    const t = nextState(lead({ status: "Follow-up due", followUpCount: 1, lastOutboundAt: T0, suggestedFollowUp: "draft" }), {
      type: "outbound_message", at: T2, messageId: "m2", text: "Following up",
    });
    expect(t.status).toBe("Message sent");
    expect(t.fieldUpdates.followUpCount).toBe(2);
    expect(t.fieldUpdates.suggestedFollowUp).toBe("");
  });

  it("does not count a follow-up from other statuses", () => {
    const t = nextState(lead({ status: "Replied", lastOutboundAt: T0, lastInboundAt: T1 }), {
      type: "outbound_message", at: T2, messageId: "m2", text: "Great, talk Monday",
    });
    expect(t.status).toBe("Message sent");
    expect(t.fieldUpdates.followUpCount).toBeUndefined();
  });

  it("ignores an outbound message older than the latest one (out of order)", () => {
    const t = nextState(lead({ status: "Opened", lastOutboundAt: T2 }), {
      type: "outbound_message", at: T0, messageId: "m0", text: "old",
    });
    expect(t.changed).toBe(false);
    expect(t.status).toBe("Opened");
  });

  it("ignores an outbound message the lead already replied after", () => {
    const t = nextState(lead({ status: "Replied", lastInboundAt: T2 }), {
      type: "outbound_message", at: T1, messageId: "m1", text: "hi",
    });
    expect(t.changed).toBe(false);
    expect(t.status).toBe("Replied");
  });
});

describe("delivery event for latest outbound", () => {
  it("moves Message sent to Delivered", () => {
    const t = nextState(lead({ status: "Message sent", lastOutboundAt: T0 }), {
      type: "delivered", at: T1, messageId: "m1", messageSentAt: T0,
    });
    expect(t.status).toBe("Delivered");
    expect(t.changed).toBe(true);
  });

  it.each(["Not contacted", "Delivered", "Opened", "Replied", "Follow-up due", "Not replied"] as const)(
    "does nothing when status is %s",
    (status) => {
      const t = nextState(lead({ status, lastOutboundAt: T0 }), { type: "delivered", at: T1, messageId: "m1" });
      expect(t.changed).toBe(false);
      expect(t.status).toBe(status);
    },
  );

  it("ignores delivery of an older message", () => {
    const t = nextState(lead({ status: "Message sent", lastOutboundAt: T1 }), {
      type: "delivered", at: T2, messageId: "m0", messageSentAt: T0,
    });
    expect(t.changed).toBe(false);
  });

  it("ignores a receipt that happened before our latest message was sent", () => {
    const t = nextState(lead({ status: "Message sent", lastOutboundAt: T2 }), {
      type: "delivered", at: T1, messageId: "m0",
    });
    expect(t.changed).toBe(false);
  });
});

describe("read event for latest outbound", () => {
  it.each(["Message sent", "Delivered"] as const)("moves %s to Opened and sets Opened At", (status) => {
    const t = nextState(lead({ status, lastOutboundAt: T0 }), { type: "read", at: T1, messageId: "m1", messageSentAt: T0 });
    expect(t.status).toBe("Opened");
    expect(t.fieldUpdates.openedAt).toBe(T1);
  });

  it.each(["Not contacted", "Opened", "Replied", "Follow-up due", "Not replied"] as const)(
    "does nothing when status is %s",
    (status) => {
      const t = nextState(lead({ status, lastOutboundAt: T0 }), { type: "read", at: T1, messageId: "m1" });
      expect(t.changed).toBe(false);
      expect(t.status).toBe(status);
    },
  );

  it("ignores a read receipt for an older message", () => {
    const t = nextState(lead({ status: "Delivered", lastOutboundAt: T1 }), {
      type: "read", at: T2, messageId: "m0", messageSentAt: T0,
    });
    expect(t.changed).toBe(false);
    expect(t.status).toBe("Delivered");
  });

  it("does not move Opened back to Delivered when the delivery arrives late", () => {
    const opened = lead({ status: "Opened", lastOutboundAt: T0, openedAt: T2 });
    const t = nextState(opened, { type: "delivered", at: T1, messageId: "m1", messageSentAt: T0 });
    expect(t.changed).toBe(false);
    expect(t.status).toBe("Opened");
  });
});

describe("inbound message from lead", () => {
  it.each(["Not contacted", "Message sent", "Delivered", "Opened", "Follow-up due", "Not replied", "Replied"] as const)(
    "moves %s to Replied and asks for classification",
    (status) => {
      const t = nextState(lead({ status, lastOutboundAt: T0 }), {
        type: "inbound_message", at: T1, messageId: "r1", text: "Sure, Monday works",
      });
      expect(t.status).toBe("Replied");
      expect(t.fieldUpdates).toMatchObject({ lastInboundAt: T1, lastMessageSnippet: "Sure, Monday works" });
      expect(t.effects).toEqual(["classify_reply"]);
    },
  );

  it("keeps our newer outbound as the latest turn when an old reply arrives late", () => {
    const t = nextState(lead({ status: "Message sent", lastOutboundAt: T2 }), {
      type: "inbound_message", at: T1, messageId: "r1", text: "late",
    });
    expect(t.status).toBe("Message sent");
    expect(t.fieldUpdates).toEqual({ lastInboundAt: T1 });
    expect(t.effects).toEqual([]);
  });

  it("ignores an inbound message older than the latest inbound", () => {
    const t = nextState(lead({ status: "Replied", lastOutboundAt: T0, lastInboundAt: T2 }), {
      type: "inbound_message", at: T1, messageId: "r0", text: "old",
    });
    expect(t.changed).toBe(false);
  });
});

describe("daily job", () => {
  const sent = (overrides: Partial<Lead> = {}) => lead({ status: "Message sent", lastOutboundAt: T0, ...overrides });

  it.each(["Message sent", "Delivered", "Opened"] as const)(
    "moves %s to Follow-up due after the wait and asks for a draft",
    (status) => {
      const t = nextState(sent({ status }), { type: "daily_check", now: daysAfter(T0, 3) }, RULES);
      expect(t.status).toBe("Follow-up due");
      expect(t.effects).toEqual(["draft_follow_up"]);
    },
  );

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

  it.each(["Not contacted", "Replied", "Follow-up due", "Not replied"] as const)("leaves %s alone", (status) => {
    const t = nextState(sent({ status }), { type: "daily_check", now: daysAfter(T0, 10) }, RULES);
    expect(t.changed).toBe(false);
  });

  it("does nothing when the lead replied after our last message", () => {
    const t = nextState(sent({ status: "Opened", lastInboundAt: T1 }), { type: "daily_check", now: daysAfter(T0, 10) }, RULES);
    expect(t.changed).toBe(false);
  });

  it("supports minute based thresholds for the demo", () => {
    const rules: Rules = { notRepliedAfterMs: 2 * 60_000, maxFollowUps: 2 };
    expect(nextState(sent(), { type: "daily_check", now: "2026-10-24T10:01:00.000Z" }, rules).changed).toBe(false);
    expect(nextState(sent(), { type: "daily_check", now: "2026-10-24T10:02:00.000Z" }, rules).status).toBe("Follow-up due");
  });
});

describe("full conversation", () => {
  it("walks Message sent, Delivered, Opened, Follow-up due, Message sent, Replied", () => {
    let l = lead();
    const apply = (e: Parameters<typeof nextState>[1]) => {
      const t = nextState(l, e, RULES);
      l = { ...l, ...t.fieldUpdates };
      return t.status;
    };
    expect(apply({ type: "outbound_message", at: T0, messageId: "m1", text: "Hi" })).toBe("Message sent");
    expect(apply({ type: "delivered", at: T1, messageId: "m1", messageSentAt: T0 })).toBe("Delivered");
    expect(apply({ type: "read", at: T2, messageId: "m1", messageSentAt: T0 })).toBe("Opened");
    expect(apply({ type: "daily_check", now: daysAfter(T0, 3) })).toBe("Follow-up due");
    const t4 = daysAfter(T0, 3.1);
    expect(apply({ type: "outbound_message", at: t4, messageId: "m2", text: "Bumping this" })).toBe("Message sent");
    expect(l.followUpCount).toBe(1);
    // A late read receipt for the first message must not mark the follow-up as opened.
    expect(apply({ type: "read", at: daysAfter(T0, 3.2), messageId: "m1", messageSentAt: T0 })).toBe("Message sent");
    expect(apply({ type: "inbound_message", at: daysAfter(T0, 3.3), messageId: "r1", text: "Yes, let's talk" })).toBe("Replied");
  });
});

describe("snippet", () => {
  it("flattens whitespace and keeps the first 100 characters", () => {
    expect(snippet("  hello\n\nthere  ")).toBe("hello there");
    expect(snippet("x".repeat(150))).toHaveLength(100);
  });
});
