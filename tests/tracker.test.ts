// End-to-end tests of the pipeline: webhook payload in, CRM rows out.
// Uses the in-memory CRM, an in-memory SQLite and fakes for Unipile and the LLM.

import { describe, expect, it } from "vitest";
import { CHAT_ID, LEAD_PROVIDER_ID, fixture, setup } from "./helpers.js";

async function withManualLead() {
  const ctx = setup();
  ctx.crm.addRow({ name: "Bastien", company: "Unipile", linkedinUrl: "https://www.linkedin.com/in/bastien-u/" });
  ctx.unipile.profiles.set("bastien-u", { provider_id: LEAD_PROVIDER_ID });
  await ctx.tracker.syncLeads();
  await ctx.tracker.idle();
  return ctx;
}

describe("lead sync", () => {
  it("gives a new row an id, sets Not contacted and resolves the provider id", async () => {
    const { crm, unipile } = await withManualLead();
    expect(crm.get("L-0001")).toMatchObject({
      name: "Bastien",
      status: "Not contacted",
      providerId: LEAD_PROVIDER_ID,
      source: "Manual",
    });
    expect(unipile.profileCalls).toEqual(["bastien-u"]);
    expect(crm.events.map((e) => e.eventType)).toEqual(["lead_added"]);
  });

  it("does not re-add or re-resolve a lead on the next sync", async () => {
    const { crm, tracker, unipile } = await withManualLead();
    await tracker.syncLeads();
    expect(crm.leads).toHaveLength(1);
    expect(unipile.profileCalls).toHaveLength(1);
  });

  it("gives up resolving after a few failed attempts", async () => {
    const ctx = setup();
    ctx.crm.addRow({ name: "Ghost", linkedinUrl: "https://www.linkedin.com/in/does-not-exist/" });
    for (let i = 0; i < 5; i++) await ctx.tracker.syncLeads();
    expect(ctx.unipile.profileCalls).toHaveLength(3);
    expect(ctx.crm.get("L-0001")?.status).toBe("Not contacted");
  });
});

describe("conversation flow", () => {
  it("moves a lead through Message sent, Delivered, Opened and Replied with an AI label", async () => {
    const ctx = await withManualLead();
    const { crm, deliver, setNow } = ctx;

    await deliver(fixture("message_received.outbound"));
    expect(crm.get("L-0001")).toMatchObject({
      status: "Message sent",
      chatId: CHAT_ID,
      lastOutboundAt: "2026-10-24T13:49:07.965Z",
      lastMessageSnippet: "Hi Bastien, saw your post on outbound tooling. Open to a quick chat?",
    });

    setNow("2026-10-24T13:49:10.000Z");
    await deliver(fixture("message_delivered"));
    expect(crm.get("L-0001")?.status).toBe("Delivered");

    setNow("2026-10-24T13:52:31.000Z");
    await deliver(fixture("message_read"));
    expect(crm.get("L-0001")).toMatchObject({ status: "Opened", openedAt: "2026-10-24T13:52:31.000Z" });

    setNow("2026-10-24T14:05:42.000Z");
    await deliver(fixture("message_received.inbound"));
    expect(crm.get("L-0001")).toMatchObject({
      status: "Replied",
      lastInboundAt: "2026-10-24T14:05:41.000Z",
      replyCategory: "Interested",
      replySummary: "Open to a call on Monday",
      suggestedFollowUp: "Great, does 11am Monday work?",
    });

    expect(crm.events.map((e) => [e.eventType, e.oldStatus, e.newStatus])).toEqual([
      ["lead_added", "", "Not contacted"],
      ["outbound_message", "Not contacted", "Message sent"],
      ["delivered", "Message sent", "Delivered"],
      ["read", "Delivered", "Opened"],
      ["inbound_message", "Opened", "Replied"],
    ]);
  });

  it("sends recent thread context to the classifier", async () => {
    const ctx = await withManualLead();
    ctx.unipile.threads.set(CHAT_ID, [
      { fromLead: false, text: "Hi Bastien", at: "2026-10-24T13:49:07.965Z" },
      { fromLead: true, text: "Sure, happy to talk", at: "2026-10-24T14:05:41.000Z" },
    ]);
    await ctx.deliver(fixture("message_received.outbound"));
    await ctx.deliver(fixture("message_received.inbound"));
    expect(ctx.classifier.seenThreads[0]).toHaveLength(2);
  });

  it("falls back to the latest reply when the thread cannot be loaded", async () => {
    const ctx = await withManualLead();
    await ctx.deliver(fixture("message_received.outbound"));
    await ctx.deliver(fixture("message_received.inbound"));
    expect(ctx.classifier.seenThreads[0]).toEqual([
      { fromLead: true, text: "Sure, happy to talk. Does Monday morning work?", at: "2026-10-24T14:05:41.000Z" },
    ]);
  });

  it("processes a retried webhook only once", async () => {
    const ctx = await withManualLead();
    await ctx.deliver(fixture("message_received.outbound"));
    await ctx.deliver(fixture("message_received.outbound"));
    expect(ctx.crm.events.filter((e) => e.eventType === "outbound_message")).toHaveLength(1);
    expect(ctx.logs.some((l) => l.includes("duplicate"))).toBe(true);
  });

  it("ignores a read receipt for the lead's own message (that is us reading it)", async () => {
    const ctx = await withManualLead();
    await ctx.deliver(fixture("message_received.outbound"));
    await ctx.deliver(fixture("message_received.inbound"));
    await ctx.deliver({ ...fixture("message_read"), message_id: "pQ7aZx_2RkWm4LwT9cVb1A" });
    expect(ctx.crm.get("L-0001")?.status).toBe("Replied");
  });

  it("auto-adds a lead for a chat with nobody in the sheet", async () => {
    const ctx = setup();
    await ctx.deliver(fixture("message_received.outbound"));
    expect(ctx.crm.get("L-0001")).toMatchObject({
      name: "Bastien Unipile",
      providerId: LEAD_PROVIDER_ID,
      chatId: CHAT_ID,
      source: "Auto-added",
      status: "Message sent",
    });
  });

  it("ignores events for other Unipile accounts", async () => {
    const ctx = await withManualLead();
    await ctx.deliver({ ...fixture("message_received.outbound"), account_id: "someone-else" });
    expect(ctx.crm.get("L-0001")?.status).toBe("Not contacted");
  });

  it("keeps going when a CRM write fails and retries it on the next sync", async () => {
    const ctx = await withManualLead();
    const realUpsert = ctx.crm.upsertLead.bind(ctx.crm);
    ctx.crm.upsertLead = async () => {
      throw new Error("Sheets quota exceeded");
    };
    await ctx.deliver(fixture("message_received.outbound"));
    expect(ctx.crm.get("L-0001")?.status).toBe("Not contacted");
    expect(ctx.store.getLead("L-0001")?.status).toBe("Message sent");

    ctx.crm.upsertLead = realUpsert;
    await ctx.tracker.syncLeads();
    expect(ctx.crm.get("L-0001")?.status).toBe("Message sent");
  });
});

describe("follow-up check", () => {
  it("marks an unanswered lead Follow-up due, drafts a message, then Not replied when follow-ups run out", async () => {
    const ctx = await withManualLead();
    const { crm, deliver, setNow, tracker } = ctx;
    await deliver(fixture("message_received.outbound")); // sent 2026-10-24T13:49

    setNow("2026-10-26T13:49:00.000Z"); // 2 days: too early
    await tracker.runFollowUpCheck();
    await tracker.idle();
    expect(crm.get("L-0001")?.status).toBe("Message sent");

    setNow("2026-10-27T14:00:00.000Z"); // 3 days
    await tracker.runFollowUpCheck();
    await tracker.idle();
    expect(crm.get("L-0001")).toMatchObject({
      status: "Follow-up due",
      suggestedFollowUp: "Hi, just floating this back up. Worth a quick chat?",
    });

    // Two follow-ups sent and ignored, then the lead counts as Not replied.
    for (const [i, sentAt] of ["2026-10-27T15:00:00.000Z", "2026-10-30T16:00:00.000Z"].entries()) {
      await deliver({ ...fixture("message_received.outbound"), message_id: `followup-${i}`, timestamp: sentAt });
      expect(crm.get("L-0001")).toMatchObject({ status: "Message sent", followUpCount: i + 1, suggestedFollowUp: "" });
      setNow(new Date(Date.parse(sentAt) + 3.1 * 24 * 3600 * 1000).toISOString());
      await tracker.runFollowUpCheck();
      await tracker.idle();
    }
    expect(crm.get("L-0001")?.status).toBe("Not replied");
  });
});
