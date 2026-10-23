// Turns raw Unipile webhook bodies into small internal events.
//
// Field names come from the Unipile v1 docs:
//   https://developer.unipile.com/docs/new-messages-webhook
//   https://developer.unipile.com/reference/webhookscontroller_createwebhook
// The docs show one example payload (message_received) and say read and
// delivered events share its shape. Parsing is deliberately loose so an extra
// or missing field never crashes the server; check real payloads in
// fixtures/ (captured with `npm run log-webhooks`) before trusting new fields.

import crypto from "node:crypto";
import { z } from "zod";

export interface Attendee {
  providerId: string;
  name: string;
  profileUrl: string;
}

export type NormalizedEvent =
  | {
      kind: "message";
      event: string;
      dedupeKey: string;
      accountId: string;
      chatId: string;
      messageId: string;
      at: string;
      text: string;
      direction: "outbound" | "inbound";
      /** The other person in a one to one chat, when the payload tells us. */
      counterpart: Attendee | null;
      isGroup: boolean;
    }
  | {
      kind: "delivered" | "read";
      event: string;
      dedupeKey: string;
      accountId: string;
      chatId: string;
      messageId: string;
      at: string;
    }
  | { kind: "ignored"; event: string; dedupeKey: string; accountId: string; reason: string };

const attendeeSchema = z
  .object({
    attendee_id: z.string().optional(),
    attendee_name: z.string().optional(),
    attendee_provider_id: z.string().optional(),
    attendee_profile_url: z.string().optional(),
  })
  .passthrough();

// Unipile sends some flags as 0/1 numbers elsewhere in the API, so accept both.
const flag = z.union([z.boolean(), z.number(), z.string()]).optional();

const payloadSchema = z
  .object({
    event: z.string(),
    account_id: z.string().optional(),
    account_type: z.string().optional(),
    account_info: z.object({ user_id: z.string().optional() }).passthrough().optional(),
    chat_id: z.string().optional(),
    message_id: z.string().optional(),
    message: z.string().nullable().optional(),
    timestamp: z.string().optional(),
    sender: attendeeSchema.optional(),
    attendees: z.array(attendeeSchema).optional(),
    is_sender: flag,
    is_group: flag,
    is_event: flag,
  })
  .passthrough();

export type UnipilePayload = z.infer<typeof payloadSchema>;

/** Unipile has no signature scheme in v1; we register a secret header and compare it here. */
export function isAuthorized(received: string | undefined, secret: string): boolean {
  if (!received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function normalize(raw: unknown, receivedAt: string): NormalizedEvent {
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: "ignored", event: "unknown", dedupeKey: hashKey(raw), accountId: "", reason: "not a messaging payload" };
  }
  const p = parsed.data;
  const accountId = p.account_id ?? "";
  const dedupeKey = p.message_id ? `${p.event}:${p.message_id}` : `${p.event}:${hashKey(raw)}`;
  const ignored = (reason: string): NormalizedEvent => ({ kind: "ignored", event: p.event, dedupeKey, accountId, reason });

  if (p.account_type && p.account_type !== "LINKEDIN") return ignored(`account type ${p.account_type}`);
  if (!p.chat_id || !p.message_id) return ignored("missing chat_id or message_id");
  const at = p.timestamp ?? receivedAt;

  if (p.event === "message_delivered" || p.event === "message_read") {
    return {
      kind: p.event === "message_read" ? "read" : "delivered",
      event: p.event,
      dedupeKey,
      accountId,
      chatId: p.chat_id,
      messageId: p.message_id,
      at,
    };
  }

  if (p.event !== "message_received") return ignored(`event ${p.event} does not affect status`);
  if (truthy(p.is_event)) return ignored("system event, not a real message");

  const selfId = p.account_info?.user_id;
  const isSender = p.is_sender !== undefined ? truthy(p.is_sender) : undefined;
  let direction: "outbound" | "inbound";
  if (isSender !== undefined) {
    direction = isSender ? "outbound" : "inbound";
  } else if (selfId && p.sender?.attendee_provider_id) {
    // Documented rule: compare account_info.user_id with sender.attendee_provider_id.
    direction = p.sender.attendee_provider_id === selfId ? "outbound" : "inbound";
  } else {
    return ignored("cannot tell who sent the message");
  }

  const others = (p.attendees ?? [])
    .filter((a) => a.attendee_provider_id && a.attendee_provider_id !== selfId)
    .map(toAttendee);
  // Some payloads may list the sender in attendees too; dedupe by provider id.
  const uniqueOthers = [...new Map(others.map((a) => [a.providerId, a])).values()];

  let counterpart: Attendee | null = null;
  if (direction === "inbound" && p.sender?.attendee_provider_id) counterpart = toAttendee(p.sender);
  else if (uniqueOthers.length === 1) counterpart = uniqueOthers[0];

  return {
    kind: "message",
    event: p.event,
    dedupeKey,
    accountId,
    chatId: p.chat_id,
    messageId: p.message_id,
    at,
    text: p.message ?? "",
    direction,
    counterpart,
    isGroup: truthy(p.is_group) || uniqueOthers.length > 1,
  };
}

function toAttendee(a: z.infer<typeof attendeeSchema>): Attendee {
  return {
    providerId: a.attendee_provider_id ?? "",
    name: (a.attendee_name ?? "").trim(),
    profileUrl: a.attendee_profile_url ?? "",
  };
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

function hashKey(raw: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(raw ?? null)).digest("hex").slice(0, 32);
}
