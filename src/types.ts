// Shared domain types. These are the words the whole codebase uses.

export const LEAD_STATUSES = [
  "Not contacted",
  "Message sent",
  "Delivered",
  "Opened",
  "Replied",
  "Follow-up due",
  "Not replied",
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const REPLY_CATEGORIES = [
  "Interested",
  "Not interested",
  "Question",
  "Later",
  "Other",
] as const;

export type ReplyCategory = (typeof REPLY_CATEGORIES)[number] | "Unclassified";

export type LeadSource = "Manual" | "Auto-added";

/** One lead, one row in the CRM. Timestamps are ISO strings, empty string when unset. */
export interface Lead {
  leadId: string;
  name: string;
  company: string;
  linkedinUrl: string;
  providerId: string;
  chatId: string;
  /** Empty only for a row a human just added and the server has not processed yet. */
  status: LeadStatus | "";
  replyCategory: string;
  replySummary: string;
  lastMessageSnippet: string;
  lastOutboundAt: string;
  openedAt: string;
  lastInboundAt: string;
  followUpCount: number;
  suggestedFollowUp: string;
  source: LeadSource | "";
  updatedAt: string;
}

/** A row for the Events tab. */
export interface LeadEvent {
  timestamp: string;
  leadId: string;
  eventType: string;
  direction: "outbound" | "inbound" | "";
  messageId: string;
  oldStatus: string;
  newStatus: string;
}

export function emptyLead(leadId: string): Lead {
  return {
    leadId,
    name: "",
    company: "",
    linkedinUrl: "",
    providerId: "",
    chatId: "",
    status: "",
    replyCategory: "",
    replySummary: "",
    lastMessageSnippet: "",
    lastOutboundAt: "",
    openedAt: "",
    lastInboundAt: "",
    followUpCount: 0,
    suggestedFollowUp: "",
    source: "",
    updatedAt: "",
  };
}
