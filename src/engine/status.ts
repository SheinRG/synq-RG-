// The status engine. Pure functions only: no I/O, no clock, no randomness.
// Every rule here maps to one row of the status table in the build brief.

import type { Lead, LeadStatus } from "../types.js";

export type EngineEvent =
  | { type: "lead_added" }
  | { type: "outbound_message"; at: string; messageId: string; text: string }
  | { type: "inbound_message"; at: string; messageId: string; text: string }
  /** messageSentAt is when the delivered/read message was sent, if we know it. */
  | { type: "delivered"; at: string; messageId: string; messageSentAt?: string }
  | { type: "read"; at: string; messageId: string; messageSentAt?: string }
  | { type: "daily_check"; now: string };

/** Work the caller should do after applying a transition. */
export type Effect = "resolve_provider_id" | "classify_reply" | "draft_follow_up";

export interface Transition {
  status: LeadStatus | "";
  fieldUpdates: Partial<Lead>;
  effects: Effect[];
  /** False when the event was ignored and nothing should be written. */
  changed: boolean;
  /** Why an event was ignored. Handy in logs. */
  reason?: string;
}

export interface Rules {
  /** How long after our last message a lead counts as not replying. */
  notRepliedAfterMs: number;
  maxFollowUps: number;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RULES: Rules = { notRepliedAfterMs: 3 * DAY_MS, maxFollowUps: 2 };

const SNIPPET_LENGTH = 100;
const AWAITING_REPLY: LeadStatus[] = ["Message sent", "Delivered", "Opened"];

export function nextState(lead: Lead, event: EngineEvent, rules: Rules = DEFAULT_RULES): Transition {
  switch (event.type) {
    case "lead_added":
      return onLeadAdded(lead);
    case "outbound_message":
      return onOutbound(lead, event);
    case "delivered":
      return onDelivered(lead, event);
    case "read":
      return onRead(lead, event);
    case "inbound_message":
      return onInbound(lead, event);
    case "daily_check":
      return onDailyCheck(lead, event.now, rules);
  }
}

function onLeadAdded(lead: Lead): Transition {
  if (lead.status !== "") return ignore(lead, "lead already has a status");
  return {
    status: "Not contacted",
    fieldUpdates: { status: "Not contacted" },
    effects: lead.providerId ? [] : ["resolve_provider_id"],
    changed: true,
  };
}

function onOutbound(lead: Lead, event: { at: string; text: string }): Transition {
  if (isBefore(event.at, lead.lastOutboundAt)) {
    return ignore(lead, "older than our latest outbound message");
  }
  if (isBefore(event.at, lead.lastInboundAt)) {
    // The lead already answered after this message, so the latest turn is theirs.
    return ignore(lead, "lead replied after this message");
  }

  const fieldUpdates: Partial<Lead> = {
    status: "Message sent",
    lastOutboundAt: event.at,
    openedAt: "",
    lastMessageSnippet: snippet(event.text),
  };
  if (lead.status === "Follow-up due") {
    fieldUpdates.followUpCount = lead.followUpCount + 1;
    // The draft has been used (or ignored); either way it is stale now.
    fieldUpdates.suggestedFollowUp = "";
  }
  return { status: "Message sent", fieldUpdates, effects: [], changed: true };
}

function onDelivered(lead: Lead, event: { at: string; messageSentAt?: string }): Transition {
  if (refersToOlderMessage(lead, event)) return ignore(lead, "refers to an older message");
  if (lead.status !== "Message sent") return ignore(lead, `status is ${lead.status || "empty"}`);
  return { status: "Delivered", fieldUpdates: { status: "Delivered" }, effects: [], changed: true };
}

function onRead(lead: Lead, event: { at: string; messageSentAt?: string }): Transition {
  if (refersToOlderMessage(lead, event)) return ignore(lead, "refers to an older message");
  if (lead.status !== "Message sent" && lead.status !== "Delivered") {
    return ignore(lead, `status is ${lead.status || "empty"}`);
  }
  return {
    status: "Opened",
    fieldUpdates: { status: "Opened", openedAt: event.at },
    effects: [],
    changed: true,
  };
}

function onInbound(lead: Lead, event: { at: string; text: string }): Transition {
  if (isBefore(event.at, lead.lastInboundAt)) {
    return ignore(lead, "older than the latest inbound message");
  }
  if (isBefore(event.at, lead.lastOutboundAt)) {
    // We wrote again after this reply, so the latest turn is ours. Keep the
    // status, but remember the reply happened.
    return {
      status: lead.status,
      fieldUpdates: { lastInboundAt: event.at },
      effects: [],
      changed: true,
      reason: "reply is older than our latest outbound message",
    };
  }
  return {
    status: "Replied",
    fieldUpdates: {
      status: "Replied",
      lastInboundAt: event.at,
      lastMessageSnippet: snippet(event.text),
    },
    effects: ["classify_reply"],
    changed: true,
  };
}

function onDailyCheck(lead: Lead, now: string, rules: Rules): Transition {
  if (!AWAITING_REPLY.includes(lead.status as LeadStatus)) {
    return ignore(lead, `status is ${lead.status || "empty"}`);
  }
  if (!lead.lastOutboundAt) return ignore(lead, "no outbound message recorded");
  if (lead.lastInboundAt && !isBefore(lead.lastInboundAt, lead.lastOutboundAt)) {
    return ignore(lead, "lead replied after our last message");
  }
  const waitedMs = Date.parse(now) - Date.parse(lead.lastOutboundAt);
  if (waitedMs < rules.notRepliedAfterMs) return ignore(lead, "not waited long enough");

  if (lead.followUpCount < rules.maxFollowUps) {
    return {
      status: "Follow-up due",
      fieldUpdates: { status: "Follow-up due" },
      effects: ["draft_follow_up"],
      changed: true,
    };
  }
  return { status: "Not replied", fieldUpdates: { status: "Not replied" }, effects: [], changed: true };
}

/** A delivery or read receipt that belongs to a message older than our latest outbound. */
function refersToOlderMessage(lead: Lead, event: { at: string; messageSentAt?: string }): boolean {
  if (!lead.lastOutboundAt) return false;
  // When we know which message the receipt is for, that alone decides.
  if (event.messageSentAt) return isBefore(event.messageSentAt, lead.lastOutboundAt);
  // Otherwise: a receipt that happened before our latest message was sent cannot be about it.
  return isBefore(event.at, lead.lastOutboundAt);
}

function ignore(lead: Lead, reason: string): Transition {
  return { status: lead.status, fieldUpdates: {}, effects: [], changed: false, reason };
}

/** True when a is strictly earlier than b. An empty b means "no reference point", so false. */
function isBefore(a: string, b: string): boolean {
  if (!a || !b) return false;
  return Date.parse(a) < Date.parse(b);
}

export function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_LENGTH);
}
