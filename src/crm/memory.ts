// In-memory CRM adapter. Used by the tests, and a handy reference for anyone
// writing a new adapter: it is the whole contract in a few lines.

import type { CrmAdapter } from "./adapter.js";
import type { LeadIdAllocator } from "./googleSheets.js";
import { emptyLead, type Lead, type LeadEvent, type LeadStatus } from "../types.js";

export class MemoryCrm implements CrmAdapter {
  leads: Lead[] = [];
  events: LeadEvent[] = [];

  constructor(private ids: LeadIdAllocator) {}

  /** Simulates a person typing a new row into the sheet. */
  addRow(fields: Partial<Lead>): void {
    this.leads.push({ ...emptyLead(""), ...fields });
  }

  async listLeads(): Promise<Lead[]> {
    for (const lead of this.leads) {
      if (!lead.leadId) {
        lead.leadId = this.ids.next();
        lead.source = lead.source || "Manual";
      }
    }
    return this.leads.map((l) => ({ ...l }));
  }

  async upsertLead(lead: Partial<Lead> & { leadId: string }): Promise<void> {
    const existing = this.leads.find((l) => l.leadId === lead.leadId);
    if (existing) Object.assign(existing, stripUndefined(lead));
    else this.leads.push({ ...emptyLead(lead.leadId), ...stripUndefined(lead) });
  }

  async updateStatus(leadId: string, status: LeadStatus, fields: Partial<Lead>): Promise<void> {
    await this.upsertLead({ ...fields, status, leadId });
  }

  async logEvent(event: LeadEvent): Promise<void> {
    this.events.push(event);
  }

  get(leadId: string): Lead | undefined {
    return this.leads.find((l) => l.leadId === leadId);
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
