// Google Sheets implementation of the CRM adapter.
//
// Tabs: Leads (one row per lead), Events (append-only log), Summary (formulas).
// Rows are always found by Lead ID, never by a remembered row number, so
// people can sort or insert rows while the server is running. The one
// exception is giving a brand new human-added row its Lead ID, which is done
// right after reading the sheet. All values are written RAW so message text
// that starts with "=" can never become a formula.

import fs from "node:fs";
import { google, type sheets_v4 } from "googleapis";
import type { CrmAdapter } from "./adapter.js";
import { LEAD_STATUSES, type Lead, type LeadEvent, type LeadStatus } from "../types.js";
import { leadNumber } from "../db/index.js";

export const LEADS_TAB = "Leads";
export const EVENTS_TAB = "Events";
export const SUMMARY_TAB = "Summary";

/** Column order of the Leads tab. Humans fill Name, Company and LinkedIn URL. */
export const LEAD_COLUMNS: { header: string; key: keyof Lead }[] = [
  { header: "Lead ID", key: "leadId" },
  { header: "Name", key: "name" },
  { header: "Company", key: "company" },
  { header: "LinkedIn URL", key: "linkedinUrl" },
  { header: "Provider ID", key: "providerId" },
  { header: "Chat ID", key: "chatId" },
  { header: "Status", key: "status" },
  { header: "Reply Category", key: "replyCategory" },
  { header: "Reply Summary", key: "replySummary" },
  { header: "Last Message Snippet", key: "lastMessageSnippet" },
  { header: "Last Outbound At", key: "lastOutboundAt" },
  { header: "Opened At", key: "openedAt" },
  { header: "Last Inbound At", key: "lastInboundAt" },
  { header: "Follow-up Count", key: "followUpCount" },
  { header: "Suggested Follow-up", key: "suggestedFollowUp" },
  { header: "Source", key: "source" },
  { header: "Updated At", key: "updatedAt" },
];

export const EVENT_HEADERS = ["Timestamp", "Lead ID", "Event Type", "Direction", "Message ID", "Old Status", "New Status"];

export interface LeadIdAllocator {
  next(): string;
  bumpTo(atLeast: number): void;
}

export class GoogleSheetsCrm implements CrmAdapter {
  private sheets: sheets_v4.Sheets;

  constructor(
    private spreadsheetId: string,
    credentials: object,
    private ids: LeadIdAllocator,
  ) {
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    this.sheets = google.sheets({ version: "v4", auth });
  }

  async listLeads(): Promise<Lead[]> {
    const rows = await this.readRange(`${LEADS_TAB}!A1:ZZ`);
    const columns = this.columnIndex(rows[0] ?? []);
    const idCol = columns.get("leadId")!;
    const sourceCol = columns.get("source");

    const existingMax = Math.max(0, ...rows.slice(1).map((r) => leadNumber(r[idCol] ?? "")));
    this.ids.bumpTo(existingMax);

    const leads: Lead[] = [];
    const newIdWrites: sheets_v4.Schema$ValueRange[] = [];
    rows.slice(1).forEach((row, i) => {
      const lead = this.rowToLead(row, columns);
      if (!lead.leadId && !lead.name && !lead.linkedinUrl) return; // blank row
      if (!lead.leadId) {
        lead.leadId = this.ids.next();
        lead.source = lead.source || "Manual";
        const rowNumber = i + 2; // +1 for the header, +1 because sheets count from 1
        newIdWrites.push({ range: `${LEADS_TAB}!${columnLetter(idCol)}${rowNumber}`, values: [[lead.leadId]] });
        if (sourceCol !== undefined) {
          newIdWrites.push({ range: `${LEADS_TAB}!${columnLetter(sourceCol)}${rowNumber}`, values: [[lead.source]] });
        }
      }
      leads.push(lead);
    });

    if (newIdWrites.length) await this.batchWrite(newIdWrites);
    return leads;
  }

  async upsertLead(lead: Partial<Lead> & { leadId: string }): Promise<void> {
    const { columns, rowNumber } = await this.locate(lead.leadId);
    if (rowNumber) {
      await this.writeFields(rowNumber, columns, lead);
      return;
    }
    const width = Math.max(...columns.values()) + 1;
    const row: (string | number)[] = new Array(width).fill("");
    for (const { key } of LEAD_COLUMNS) {
      const col = columns.get(key);
      const value = lead[key];
      if (col !== undefined && value !== undefined) row[col] = value as string | number;
    }
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${LEADS_TAB}!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });
  }

  async updateStatus(leadId: string, status: LeadStatus, fields: Partial<Lead>): Promise<void> {
    await this.upsertLead({ ...fields, status, leadId });
  }

  async logEvent(event: LeadEvent): Promise<void> {
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${EVENTS_TAB}!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [
          [event.timestamp, event.leadId, event.eventType, event.direction, event.messageId, event.oldStatus, event.newStatus],
        ],
      },
    });
  }

  // ---- helpers --------------------------------------------------------

  /** Finds the lead's row by Lead ID. One read call (header row plus column A). */
  private async locate(leadId: string): Promise<{ columns: Map<keyof Lead, number>; rowNumber: number | null }> {
    const res = await this.sheets.spreadsheets.values.batchGet({
      spreadsheetId: this.spreadsheetId,
      ranges: [`${LEADS_TAB}!1:1`, `${LEADS_TAB}!A:A`],
    });
    const [headerRange, idRange] = res.data.valueRanges ?? [];
    const columns = this.columnIndex(((headerRange?.values ?? [])[0] ?? []) as string[]);
    let ids = (idRange?.values ?? []) as string[][];
    const idCol = columns.get("leadId")!;
    if (idCol !== 0) {
      // Someone moved the Lead ID column; read the right one instead.
      const letter = columnLetter(idCol);
      ids = await this.readRange(`${LEADS_TAB}!${letter}:${letter}`);
    }
    const index = ids.findIndex((r) => String(r[0] ?? "").trim() === leadId);
    return { columns, rowNumber: index > 0 ? index + 1 : null };
  }

  /** One API call for all changed cells of a row. */
  private async writeFields(rowNumber: number, columns: Map<keyof Lead, number>, fields: Partial<Lead>): Promise<void> {
    const data: sheets_v4.Schema$ValueRange[] = [];
    for (const [key, value] of Object.entries(fields) as [keyof Lead, unknown][]) {
      const col = columns.get(key);
      if (col === undefined || value === undefined || key === "leadId") continue;
      data.push({ range: `${LEADS_TAB}!${columnLetter(col)}${rowNumber}`, values: [[value as string | number]] });
    }
    if (data.length) await this.batchWrite(data);
  }

  private async batchWrite(data: sheets_v4.Schema$ValueRange[]): Promise<void> {
    await this.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { valueInputOption: "RAW", data },
    });
  }

  private async readRange(range: string): Promise<string[][]> {
    const res = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range });
    return (res.data.values ?? []) as string[][];
  }

  /** Maps each Lead field to its column, using the header text. */
  private columnIndex(header: string[]): Map<keyof Lead, number> {
    const byHeader = new Map(header.map((h, i) => [String(h).trim().toLowerCase(), i]));
    const columns = new Map<keyof Lead, number>();
    for (const { header: name, key } of LEAD_COLUMNS) {
      const i = byHeader.get(name.toLowerCase());
      if (i !== undefined) columns.set(key, i);
    }
    if (!columns.has("leadId")) {
      throw new Error(`The ${LEADS_TAB} tab has no "Lead ID" header. Run \`npm run setup-sheet\` first.`);
    }
    return columns;
  }

  private rowToLead(row: string[], columns: Map<keyof Lead, number>): Lead {
    const get = (key: keyof Lead) => {
      const i = columns.get(key);
      return i === undefined ? "" : String(row[i] ?? "").trim();
    };
    const status = get("status");
    const source = get("source");
    return {
      leadId: get("leadId"),
      name: get("name"),
      company: get("company"),
      linkedinUrl: get("linkedinUrl"),
      providerId: get("providerId"),
      chatId: get("chatId"),
      status: (LEAD_STATUSES as readonly string[]).includes(status) ? (status as LeadStatus) : "",
      replyCategory: get("replyCategory"),
      replySummary: get("replySummary"),
      lastMessageSnippet: get("lastMessageSnippet"),
      lastOutboundAt: get("lastOutboundAt"),
      openedAt: get("openedAt"),
      lastInboundAt: get("lastInboundAt"),
      followUpCount: Number(get("followUpCount")) || 0,
      suggestedFollowUp: get("suggestedFollowUp"),
      source: source === "Manual" || source === "Auto-added" ? source : "",
      updatedAt: get("updatedAt"),
    };
  }
}

/** Accepts a path to the key file or the raw JSON itself. */
export function loadServiceAccount(value: string): object {
  const text = value.trim().startsWith("{") ? value : fs.readFileSync(value, "utf8");
  return JSON.parse(text) as object;
}

/** 0 -> A, 25 -> Z, 26 -> AA */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}
