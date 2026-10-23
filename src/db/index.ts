// Small query layer over SQLite. Synchronous on purpose: better-sqlite3 is
// fast, and sync calls keep the event pipeline easy to reason about.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SCHEMA } from "./schema.js";
import type { Lead } from "../types.js";

export interface StoredMessage {
  messageId: string;
  chatId: string;
  leadId: string | null;
  direction: "outbound" | "inbound";
  sentAt: string;
  text: string;
}

export class Store {
  private db: Database.Database;

  constructor(filePath: string) {
    if (filePath !== ":memory:") fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- webhook events -------------------------------------------------

  /** Saves a raw webhook. Returns false if we already had it (a retry or duplicate). */
  recordWebhook(dedupeKey: string, event: string, payload: unknown, receivedAt: string): boolean {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO webhook_events (dedupe_key, event, received_at, payload) VALUES (?, ?, ?, ?)",
      )
      .run(dedupeKey, event, receivedAt, JSON.stringify(payload));
    return result.changes === 1;
  }

  // ---- messages -------------------------------------------------------

  saveMessage(m: StoredMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (message_id, chat_id, lead_id, direction, sent_at, text)
         VALUES (@messageId, @chatId, @leadId, @direction, @sentAt, @text)
         ON CONFLICT (message_id) DO UPDATE SET lead_id = excluded.lead_id`,
      )
      .run(m);
  }

  getMessage(messageId: string): StoredMessage | undefined {
    const row = this.db
      .prepare(
        `SELECT message_id AS messageId, chat_id AS chatId, lead_id AS leadId,
                direction, sent_at AS sentAt, text
         FROM messages WHERE message_id = ?`,
      )
      .get(messageId);
    return row as StoredMessage | undefined;
  }

  // ---- leads ----------------------------------------------------------

  saveLead(lead: Lead): void {
    this.db
      .prepare(
        `INSERT INTO leads (lead_id, provider_id, chat_id, data) VALUES (?, ?, ?, ?)
         ON CONFLICT (lead_id) DO UPDATE SET
           provider_id = excluded.provider_id, chat_id = excluded.chat_id, data = excluded.data`,
      )
      .run(lead.leadId, lead.providerId || null, lead.chatId || null, JSON.stringify(lead));
  }

  getLead(leadId: string): Lead | undefined {
    return this.parseLead(this.db.prepare("SELECT data FROM leads WHERE lead_id = ?").get(leadId));
  }

  findLeadByChatId(chatId: string): Lead | undefined {
    return this.parseLead(this.db.prepare("SELECT data FROM leads WHERE chat_id = ?").get(chatId));
  }

  findLeadByProviderId(providerId: string): Lead | undefined {
    return this.parseLead(this.db.prepare("SELECT data FROM leads WHERE provider_id = ?").get(providerId));
  }

  allLeads(): Lead[] {
    const rows = this.db.prepare("SELECT data FROM leads ORDER BY lead_id").all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Lead);
  }

  // ---- lead ids -------------------------------------------------------

  /** Hands out L-0001, L-0002, ... and never reuses a number. */
  nextLeadId(): string {
    const next = this.leadSequence() + 1;
    this.setMeta("lead_seq", String(next));
    return `L-${String(next).padStart(4, "0")}`;
  }

  /** Makes sure future ids are above any id already present in the CRM. */
  bumpLeadSequence(atLeast: number): void {
    if (atLeast > this.leadSequence()) this.setMeta("lead_seq", String(atLeast));
  }

  private leadSequence(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'lead_seq'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  private parseLead(row: unknown): Lead | undefined {
    return row ? (JSON.parse((row as { data: string }).data) as Lead) : undefined;
  }
}

export function leadNumber(leadId: string): number {
  const match = /^L-(\d+)$/.exec(leadId.trim());
  return match ? Number(match[1]) : 0;
}
