import { describe, expect, it } from "vitest";
import { code } from "./fakes.js";

const { observe, sameMessage, messageIdFor, matchLead, profileSlug, validatePayload, emptyLead } = code;

const AT = "2026-10-26T10:00:00.000Z";

function conversation(overrides = {}) {
  return {
    threadId: "2-ABC==",
    name: "Priya Sharma",
    profileUrl: "",
    isGroup: false,
    fresh: true,
    observedAt: AT,
    lastMessage: { fromMe: true, text: "Hi Priya, I saw your post about hiring" },
    seen: null,
    messages: [],
    ...overrides,
  };
}

const lead = (overrides = {}) => ({ ...emptyLead("L-0001"), status: "Not contacted", ...overrides });

describe("sameMessage", () => {
  const full = "Hi Priya, I saw your post about hiring engineers in Bangalore and wanted to ask a quick question";

  it("treats a truncated preview and the full text as the same message", () => {
    expect(sameMessage("Us", "Hi Priya, I saw your post about…", true, full)).toBe(true);
    expect(sameMessage("Us", full.slice(0, 100), true, "Hi Priya, I saw your post about hiring engineers...")).toBe(true);
  });

  it("ignores whitespace differences", () => {
    expect(sameMessage("Lead", "Sure,  Monday\nworks", false, "Sure, Monday works")).toBe(true);
  });

  it("needs the same direction", () => {
    expect(sameMessage("Lead", "Thanks!", true, "Thanks!")).toBe(false);
    expect(sameMessage("", "", true, "Hi")).toBe(false);
  });

  it("sees different texts as different messages", () => {
    expect(sameMessage("Us", "Hi Priya", true, "Following up on my note")).toBe(false);
    expect(sameMessage("Us", "Hi Priya", true, "")).toBe(false);
  });

  it("treats two empty texts as the same", () => {
    expect(sameMessage("Us", "", true, "  ")).toBe(true);
  });

  it("compares at most the first 60 characters", () => {
    const a = "x".repeat(60) + " first ending";
    const b = "x".repeat(60) + " another ending";
    expect(sameMessage("Us", a, true, b)).toBe(true);
  });
});

describe("observe", () => {
  it("turns a new outbound message into an event timed by the observation", () => {
    const events = observe(lead(), conversation(), AT);
    expect(events).toEqual([
      { type: "outbound_message", at: AT, messageId: expect.any(String), text: "Hi Priya, I saw your post about hiring" },
    ]);
  });

  it("turns a new inbound message into an inbound event", () => {
    const events = observe(lead({ lastMessageFrom: "Us", lastMessageSnippet: "Hi" }), conversation({ lastMessage: { fromMe: false, text: "Hey!" } }), AT);
    expect(events.map((e) => e.type)).toEqual(["inbound_message"]);
  });

  it("does nothing when the stored message is the one on screen (dedupe)", () => {
    const stored = lead({ lastMessageFrom: "Us", lastMessageSnippet: "Hi Priya, I saw your post about hiring" });
    expect(observe(stored, conversation(), AT)).toEqual([]);
  });

  it("does not count a truncated preview of the stored message again", () => {
    const stored = lead({ lastMessageFrom: "Us", lastMessageSnippet: "Hi Priya, I saw your post about hiring" });
    expect(observe(stored, conversation({ lastMessage: { fromMe: true, text: "Hi Priya, I saw your…" } }), AT)).toEqual([]);
  });

  it("sees our message with the same text as the lead's as a new message", () => {
    const stored = lead({ lastMessageFrom: "Lead", lastMessageSnippet: "Thanks!" });
    const events = observe(stored, conversation({ lastMessage: { fromMe: true, text: "Thanks!" } }), AT);
    expect(events.map((e) => e.type)).toEqual(["outbound_message"]);
  });

  it("adds a read event when our last message shows Seen", () => {
    const stored = lead({ lastMessageFrom: "Us", lastMessageSnippet: "Hi Priya, I saw your post about hiring" });
    const events = observe(stored, conversation({ seen: true }), AT);
    expect(events).toEqual([{ type: "read", at: AT, messageId: expect.any(String) }]);
  });

  it("ignores Seen when the last message is the lead's, and seen false or unknown", () => {
    const fromLead = conversation({ lastMessage: { fromMe: false, text: "Hey" }, seen: true });
    expect(observe(lead(), fromLead, AT).map((e) => e.type)).toEqual(["inbound_message"]);
    expect(observe(lead(), conversation({ seen: false }), AT).map((e) => e.type)).toEqual(["outbound_message"]);
  });

  it("returns nothing for a conversation without messages", () => {
    expect(observe(lead(), conversation({ lastMessage: null, seen: true }), AT)).toEqual([]);
  });

  it("gives the same message the same id and different messages different ids", () => {
    expect(messageIdFor("t1", "outbound", "Hi  there")).toBe(messageIdFor("t1", "outbound", "Hi there"));
    expect(messageIdFor("t1", "outbound", "Hi")).not.toBe(messageIdFor("t1", "inbound", "Hi"));
    expect(messageIdFor("t1", "outbound", "Hi")).not.toBe(messageIdFor("t2", "outbound", "Hi"));
    expect(messageIdFor("t1", "outbound", "Hi")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("profileSlug", () => {
  it.each([
    ["https://www.linkedin.com/in/priya-sharma/", "priya-sharma"],
    ["https://www.linkedin.com/in/priya-sharma", "priya-sharma"],
    ["https://www.linkedin.com/in/Priya-Sharma/?miniProfileUrn=urn%3Ali", "priya-sharma"],
    ["linkedin.com/in/priya-sharma#about", "priya-sharma"],
    ["https://www.linkedin.com/in/jos%C3%A9-garc%C3%ADa/", "josé-garcía"],
    ["/in/priya-sharma/", "priya-sharma"],
  ])("%s -> %s", (url, slug) => {
    expect(profileSlug(url)).toBe(slug);
  });

  it.each(["", "https://www.linkedin.com/company/acme/", "not a url", "https://example.com/inbox/x"])("no slug in %j", (url) => {
    expect(profileSlug(url)).toBeNull();
  });
});

describe("matchLead", () => {
  const leads = [
    { ...lead(), leadId: "L-0001", name: "Priya Sharma", linkedinUrl: "https://www.linkedin.com/in/priya-sharma/", threadId: "" },
    { ...lead(), leadId: "L-0002", name: "Arjun Mehta", linkedinUrl: "", threadId: "2-XYZ==" },
    { ...lead(), leadId: "L-0003", name: "Sam Lee", linkedinUrl: "" },
    { ...lead(), leadId: "L-0004", name: "Sam Lee", linkedinUrl: "" },
    { ...lead(), leadId: "L-0005", name: "Dana Fox", linkedinUrl: "", threadId: "2-OTHER" },
  ];

  it("matches by thread id first", () => {
    const m = matchLead(leads, conversation({ threadId: "2-XYZ==", name: "Priya Sharma" }));
    expect(m).toMatchObject({ lead: { leadId: "L-0002" }, by: "thread" });
  });

  it("matches a URL-encoded thread id", () => {
    expect(matchLead(leads, conversation({ threadId: "2-XYZ%3D%3D" })).lead.leadId).toBe("L-0002");
  });

  it.each([
    "https://www.linkedin.com/in/priya-sharma",
    "https://www.linkedin.com/in/PRIYA-SHARMA/",
    "https://www.linkedin.com/in/priya-sharma/?trk=msg",
    "https://www.linkedin.com/in/priya%2Dsharma/",
  ])("matches by profile slug: %s", (profileUrl) => {
    const m = matchLead(leads, conversation({ threadId: "2-NEW", name: "Someone Else", profileUrl }));
    expect(m).toMatchObject({ lead: { leadId: "L-0001" }, by: "profile" });
  });

  it("falls back to an exact name when exactly one row has it", () => {
    const m = matchLead(leads, conversation({ threadId: "2-NEW", name: "  priya   SHARMA " }));
    expect(m).toMatchObject({ lead: { leadId: "L-0001" }, by: "name" });
  });

  it("does not guess between two rows with the same name", () => {
    expect(matchLead(leads, conversation({ threadId: "2-NEW", name: "Sam Lee" }))).toBeNull();
  });

  it("does not match by name a row already linked to another thread", () => {
    expect(matchLead(leads, conversation({ threadId: "2-NEW", name: "Dana Fox" }))).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(matchLead(leads, conversation({ threadId: "2-NEW", name: "Nobody" }))).toBeNull();
  });
});

describe("validatePayload", () => {
  const body = (overrides = {}) => ({ version: 1, observedAt: AT, conversations: [conversation()], ...overrides });

  it("accepts a valid payload and cleans conversations", () => {
    const v = validatePayload(body({ conversations: [{ threadId: " 2-A ", name: 7, lastMessage: { text: "hi" }, seen: "yes" }] }));
    expect(v.ok).toBe(true);
    expect(v.payload.conversations[0]).toEqual({
      threadId: "2-A",
      threadUrl: "",
      name: "",
      profileUrl: "",
      isGroup: false,
      fresh: false,
      observedAt: AT,
      lastMessage: { fromMe: false, text: "hi" },
      seen: null,
      messages: [],
    });
  });

  it("uses a conversation's own observedAt and keeps at most 10 messages", () => {
    const messages = Array.from({ length: 15 }, (_, i) => ({ fromMe: i % 2 === 0, text: "m" + i }));
    const v = validatePayload(body({ conversations: [conversation({ observedAt: "2026-10-26T09:00:00Z", messages })] }));
    const c = v.payload.conversations[0];
    expect(c.observedAt).toBe("2026-10-26T09:00:00.000Z");
    expect(c.messages).toHaveLength(10);
    expect(c.messages[0].text).toBe("m5");
  });

  it("treats a malformed lastMessage as no message", () => {
    const v = validatePayload(body({ conversations: [conversation({ lastMessage: { fromMe: true } })] }));
    expect(v.payload.conversations[0].lastMessage).toBeNull();
  });

  it.each([
    [null, "JSON object"],
    [[], "JSON object"],
    [{ version: 2, observedAt: AT, conversations: [] }, "version"],
    [{ observedAt: AT, conversations: [] }, "version"],
    [{ version: 1, observedAt: "yesterday", conversations: [] }, "observedAt"],
    [{ version: 1, observedAt: AT }, "conversations"],
    [{ version: 1, observedAt: AT, conversations: Array(201).fill({}) }, "Too many"],
  ])("rejects %j", (input, message) => {
    const v = validatePayload(input);
    expect(v.ok).toBe(false);
    expect(v.error).toContain(message);
  });
});
