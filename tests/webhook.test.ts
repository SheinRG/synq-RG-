import { describe, expect, it } from "vitest";
import { isAuthorized, normalize } from "../src/webhooks/unipile.js";
import { fixture } from "./helpers.js";

const NOW = "2026-10-24T15:00:00.000Z";

describe("normalize", () => {
  it("treats a message from our own account as outbound", () => {
    const e = normalize(fixture("message_received.outbound"), NOW);
    expect(e).toMatchObject({
      kind: "message",
      direction: "outbound",
      chatId: "R8J-xM9WX7eoHLp6gSVtWQ",
      messageId: "ykmhfXlRW0W_cqReJYrfBw",
      at: "2026-10-24T13:49:07.965Z",
      counterpart: { providerId: "AA1212sqqsMQBODyLwZrRcgYhrkCafURGqva0U4E", name: "Bastien Unipile" },
      isGroup: false,
    });
  });

  it("treats a message from the other person as inbound", () => {
    const e = normalize(fixture("message_received.inbound"), NOW);
    expect(e).toMatchObject({ kind: "message", direction: "inbound", text: "Sure, happy to talk. Does Monday morning work?" });
    if (e.kind === "message") expect(e.counterpart?.providerId).toBe("AA1212sqqsMQBODyLwZrRcgYhrkCafURGqva0U4E");
  });

  it("prefers an explicit is_sender flag when present", () => {
    const e = normalize({ ...fixture("message_received.inbound"), is_sender: 1 }, NOW);
    expect(e).toMatchObject({ kind: "message", direction: "outbound" });
  });

  it("normalizes delivery and read receipts", () => {
    expect(normalize(fixture("message_delivered"), NOW)).toMatchObject({ kind: "delivered", messageId: "ykmhfXlRW0W_cqReJYrfBw" });
    expect(normalize(fixture("message_read"), NOW)).toMatchObject({ kind: "read", messageId: "ykmhfXlRW0W_cqReJYrfBw" });
  });

  it("builds dedupe keys from event and message id", () => {
    expect(normalize(fixture("message_read"), NOW).dedupeKey).toBe("message_read:ykmhfXlRW0W_cqReJYrfBw");
    expect(normalize(fixture("message_delivered"), NOW).dedupeKey).toBe("message_delivered:ykmhfXlRW0W_cqReJYrfBw");
  });

  it("flags group chats", () => {
    const raw = fixture("message_received.inbound");
    raw.attendees = [
      ...(raw.attendees as object[]),
      { attendee_provider_id: "ACoSomeoneElse", attendee_name: "Third Person" },
    ];
    expect(normalize(raw, NOW)).toMatchObject({ kind: "message", isGroup: true });
  });

  it("ignores events that do not affect status", () => {
    expect(normalize({ ...fixture("message_received.inbound"), event: "message_reaction" }, NOW).kind).toBe("ignored");
    expect(normalize({ ...fixture("message_received.inbound"), account_type: "WHATSAPP" }, NOW).kind).toBe("ignored");
    expect(normalize({ hello: "world" }, NOW).kind).toBe("ignored");
  });

  it("ignores a message when the sender cannot be determined", () => {
    const raw = fixture("message_received.inbound");
    delete raw.account_info;
    expect(normalize(raw, NOW)).toMatchObject({ kind: "ignored", reason: "cannot tell who sent the message" });
  });

  it("falls back to the receive time when the payload has no timestamp", () => {
    const raw = fixture("message_received.inbound");
    delete raw.timestamp;
    expect(normalize(raw, NOW)).toMatchObject({ at: NOW });
  });
});

describe("isAuthorized", () => {
  it("accepts only the exact secret", () => {
    expect(isAuthorized("s3cret-value-1234", "s3cret-value-1234")).toBe(true);
    expect(isAuthorized("s3cret-value-1235", "s3cret-value-1234")).toBe(false);
    expect(isAuthorized("short", "s3cret-value-1234")).toBe(false);
    expect(isAuthorized(undefined, "s3cret-value-1234")).toBe(false);
  });
});
