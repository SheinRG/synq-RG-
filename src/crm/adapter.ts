// The CRM boundary. Everything that writes to "the CRM" goes through this
// interface, so swapping Google Sheets for HubSpot or Zoho means writing one
// new class. See README.md for how a HubSpot version would map these methods.

import type { Lead, LeadEvent, LeadStatus } from "../types.js";

export interface CrmAdapter {
  /** All leads, including rows a human just added (those get an id assigned). */
  listLeads(): Promise<Lead[]>;
  /** Update the lead with this id, or create it if it does not exist. */
  upsertLead(lead: Partial<Lead> & { leadId: string }): Promise<void>;
  /** Write a new status plus any other changed fields in one go. */
  updateStatus(leadId: string, status: LeadStatus, fields: Partial<Lead>): Promise<void>;
  /** Append one line to the activity log. */
  logEvent(event: LeadEvent): Promise<void>;
}
