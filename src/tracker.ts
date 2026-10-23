// Wires everything together: webhook in, status engine, local store, CRM out.
//
// All state changes run one at a time through a small promise queue, so two
// webhooks for the same lead can never race. Slow work (LLM calls) runs
// outside the queue and only queues its final write, so a slow model never
// delays a status update.

import { nextState, type EngineEvent, type Rules, type Transition } from "./engine/status.js";
import { normalize, type NormalizedEvent } from "./webhooks/unipile.js";
import { linkedinSlug, type ThreadMessage, type UnipileApi } from "./services/unipile.js";
import type { CrmAdapter } from "./crm/adapter.js";
import type { ReplyClassifier } from "./ai/classifier.js";
import type { Store } from "./db/index.js";
import { emptyLead, type Lead } from "./types.js";

export interface TrackerDeps {
  store: Store;
  crm: CrmAdapter;
  unipile: UnipileApi;
  classifier: ReplyClassifier;
  rules: Rules;
  /** Our connected Unipile account. Events for other accounts are ignored. */
  accountId: string;
  now?: () => string;
  log?: (msg: string) => void;
}

const MAX_RESOLVE_ATTEMPTS = 3;

export class LeadTracker {
  private queue: Promise<unknown> = Promise.resolve();
  private background = new Set<Promise<unknown>>();
  /** Leads whose last CRM write failed. Retried on the next sync. */
  private unsynced = new Set<string>();
  private resolveAttempts = new Map<string, number>();
  private now: () => string;
  private log: (msg: string) => void;

  constructor(private deps: TrackerDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.log = deps.log ?? ((msg) => console.log(msg));
  }

  /** Called after the HTTP handler has already answered 200. */
  handleWebhook(raw: unknown): Promise<void> {
    const receivedAt = this.now();
    return this.enqueue(() => this.processWebhook(raw, receivedAt));
  }

  /** Picks up rows humans added to the CRM and resolves their LinkedIn ids. */
  syncLeads(): Promise<void> {
    return this.enqueue(() => this.processSync());
  }

  /** The "daily job": Follow-up due and Not replied. */
  runFollowUpCheck(): Promise<void> {
    return this.enqueue(async () => {
      const now = this.now();
      for (const lead of this.deps.store.allLeads()) {
        await this.apply(lead, { type: "daily_check", now }, { eventType: "daily_check" });
      }
    });
  }

  /** Waits for queued and background work. Used by tests and on shutdown. */
  async idle(): Promise<void> {
    while (true) {
      await this.queue;
      if (this.background.size === 0) return;
      await Promise.allSettled([...this.background]);
    }
  }

  // ---- webhooks -------------------------------------------------------

  private async processWebhook(raw: unknown, receivedAt: string): Promise<void> {
    const { store } = this.deps;
    const event = normalize(raw, receivedAt);

    if (!store.recordWebhook(event.dedupeKey, event.event, raw, receivedAt)) {
      this.log(`[webhook] duplicate ${event.dedupeKey}, skipped`);
      return;
    }
    if (event.accountId && event.accountId !== this.deps.accountId) {
      this.log(`[webhook] event for another account (${event.accountId}), skipped`);
      return;
    }
    if (event.kind === "ignored") {
      this.log(`[webhook] ${event.event} ignored: ${event.reason}`);
      return;
    }
    if (event.kind === "message") return this.onMessage(event);
    return this.onReceipt(event, receivedAt);
  }

  private async onMessage(event: Extract<NormalizedEvent, { kind: "message" }>): Promise<void> {
    const { store } = this.deps;
    if (event.isGroup) {
      this.log(`[webhook] group chat ${event.chatId} ignored`);
      return;
    }

    let lead =
      store.findLeadByChatId(event.chatId) ??
      (event.counterpart?.providerId ? store.findLeadByProviderId(event.counterpart.providerId) : undefined);

    if (!lead) {
      if (!event.counterpart?.providerId) {
        this.log(`[webhook] message in unknown chat ${event.chatId} with no attendee info, skipped`);
        return;
      }
      lead = await this.autoAddLead(event.chatId, event.counterpart);
    }

    if (lead.chatId !== event.chatId) {
      lead = { ...lead, chatId: event.chatId };
      store.saveLead(lead);
      await this.writeCrm(lead.leadId, { chatId: event.chatId });
    }

    store.saveMessage({
      messageId: event.messageId,
      chatId: event.chatId,
      leadId: lead.leadId,
      direction: event.direction,
      sentAt: event.at,
      text: event.text,
    });

    const engineEvent: EngineEvent =
      event.direction === "outbound"
        ? { type: "outbound_message", at: event.at, messageId: event.messageId, text: event.text }
        : { type: "inbound_message", at: event.at, messageId: event.messageId, text: event.text };
    await this.apply(lead, engineEvent, {
      eventType: engineEvent.type,
      direction: event.direction,
      messageId: event.messageId,
      text: event.text,
    });
  }

  private async onReceipt(event: Extract<NormalizedEvent, { kind: "read" | "delivered" }>, receivedAt: string) {
    const { store } = this.deps;
    const lead = store.findLeadByChatId(event.chatId);
    if (!lead) {
      this.log(`[webhook] ${event.event} for untracked chat ${event.chatId}, skipped`);
      return;
    }
    const message = store.getMessage(event.messageId);
    if (message?.direction === "inbound") {
      // That is us reading the lead's message, not the lead reading ours.
      this.log(`[webhook] ${event.event} on an inbound message, skipped`);
      return;
    }
    // Receipts use the time we received them. Webhooks arrive within seconds,
    // and the docs do not say whether the payload timestamp is the read time.
    const engineEvent: EngineEvent = {
      type: event.kind,
      at: receivedAt,
      messageId: event.messageId,
      messageSentAt: message?.sentAt,
    };
    await this.apply(lead, engineEvent, { eventType: event.kind, direction: "outbound", messageId: event.messageId });
  }

  private async autoAddLead(chatId: string, person: { providerId: string; name: string; profileUrl: string }) {
    const lead: Lead = {
      ...emptyLead(this.deps.store.nextLeadId()),
      name: person.name,
      linkedinUrl: person.profileUrl,
      providerId: person.providerId,
      chatId,
      status: "Not contacted",
      source: "Auto-added",
      updatedAt: this.now(),
    };
    this.deps.store.saveLead(lead);
    await this.writeCrm(lead.leadId, lead);
    await this.logEvent(lead, "lead_auto_added", "", "", "", "Not contacted");
    this.log(`[lead] auto-added ${lead.leadId} (${lead.name || lead.providerId})`);
    return lead;
  }

  // ---- applying transitions ---------------------------------------------

  private async apply(
    lead: Lead,
    event: EngineEvent,
    meta: { eventType: string; direction?: "outbound" | "inbound"; messageId?: string; text?: string },
  ): Promise<Transition> {
    const t = nextState(lead, event, this.deps.rules);
    if (!t.changed) {
      if (event.type !== "daily_check") this.log(`[engine] ${lead.leadId} ${meta.eventType} ignored: ${t.reason}`);
      return t;
    }

    const fields: Partial<Lead> = { ...t.fieldUpdates, updatedAt: this.now() };
    const updated: Lead = { ...lead, ...fields };
    this.deps.store.saveLead(updated);
    await this.writeCrm(lead.leadId, fields);
    await this.logEvent(lead, meta.eventType, meta.direction ?? "", meta.messageId ?? "", lead.status, updated.status);
    this.log(`[engine] ${lead.leadId} ${lead.status || "(new)"} -> ${updated.status} (${meta.eventType})`);

    for (const effect of t.effects) {
      if (effect === "classify_reply") this.inBackground(() => this.classifyReply(updated, meta.text ?? ""));
      if (effect === "draft_follow_up") this.inBackground(() => this.draftFollowUp(updated));
    }
    return t;
  }

  private async classifyReply(lead: Lead, latestText: string): Promise<void> {
    const thread = await this.threadFor(lead, { fromLead: true, text: latestText, at: lead.lastInboundAt });
    const result = await this.deps.classifier.classify(lead, thread);
    await this.enqueue(async () => {
      const current = this.deps.store.getLead(lead.leadId);
      // A newer reply arrived while we were waiting; its own classification wins.
      if (!current || current.lastInboundAt !== lead.lastInboundAt) return;
      const fields: Partial<Lead> = {
        replyCategory: result.category,
        replySummary: result.summary,
        suggestedFollowUp: result.suggestedReply,
        updatedAt: this.now(),
      };
      this.deps.store.saveLead({ ...current, ...fields });
      await this.writeCrm(lead.leadId, fields);
      this.log(`[ai] ${lead.leadId} labelled ${result.category}`);
    });
  }

  private async draftFollowUp(lead: Lead): Promise<void> {
    const thread = await this.threadFor(lead);
    const draft = await this.deps.classifier.draftFollowUp(lead, thread);
    if (!draft) return;
    await this.enqueue(async () => {
      const current = this.deps.store.getLead(lead.leadId);
      if (current?.status !== "Follow-up due") return;
      const fields: Partial<Lead> = { suggestedFollowUp: draft, updatedAt: this.now() };
      this.deps.store.saveLead({ ...current, ...fields });
      await this.writeCrm(lead.leadId, fields);
      this.log(`[ai] ${lead.leadId} follow-up drafted`);
    });
  }

  /** Last few messages for context. Falls back to what we already know. */
  private async threadFor(lead: Lead, fallback?: ThreadMessage): Promise<ThreadMessage[]> {
    if (lead.chatId) {
      try {
        const thread = await this.deps.unipile.getRecentMessages(lead.chatId);
        if (thread.length) return thread;
      } catch (err) {
        this.log(`[unipile] could not load thread for ${lead.leadId}: ${(err as Error).message}`);
      }
    }
    if (fallback) return [fallback];
    return lead.lastMessageSnippet ? [{ fromLead: false, text: lead.lastMessageSnippet, at: lead.lastOutboundAt }] : [];
  }

  // ---- lead sync ----------------------------------------------------------

  private async processSync(): Promise<void> {
    const { store, crm } = this.deps;
    const crmLeads = await crm.listLeads();

    for (const row of crmLeads) {
      const local = store.getLead(row.leadId);
      if (!local) {
        await this.addManualLead(row);
        continue;
      }
      // Humans own Name, Company and LinkedIn URL. Copy any edits.
      const urlChanged = row.linkedinUrl !== local.linkedinUrl;
      if (urlChanged || row.name !== local.name || row.company !== local.company) {
        const updated = {
          ...local,
          name: row.name,
          company: row.company,
          linkedinUrl: row.linkedinUrl,
          providerId: urlChanged && local.source === "Manual" ? "" : local.providerId,
        };
        store.saveLead(updated);
        if (urlChanged) this.resolveAttempts.delete(updated.leadId);
      }
      const current = store.getLead(row.leadId)!;
      if (!current.providerId && current.linkedinUrl) await this.resolveProviderId(current);
    }

    for (const leadId of [...this.unsynced]) {
      const lead = store.getLead(leadId);
      if (lead) await this.writeCrm(leadId, serverFields(lead));
    }
  }

  private async addManualLead(row: Lead): Promise<void> {
    const base: Lead = { ...row, status: "", source: row.source || "Manual" };
    const t = nextState(base, { type: "lead_added" }, this.deps.rules);
    const lead: Lead = { ...base, ...t.fieldUpdates, updatedAt: this.now() };
    this.deps.store.saveLead(lead);
    await this.writeCrm(lead.leadId, { status: lead.status, source: lead.source, updatedAt: lead.updatedAt });
    await this.logEvent(lead, "lead_added", "", "", "", lead.status);
    this.log(`[lead] ${lead.leadId} added from CRM (${lead.name})`);
    if (t.effects.includes("resolve_provider_id")) await this.resolveProviderId(lead);
  }

  private async resolveProviderId(lead: Lead): Promise<void> {
    const attempts = this.resolveAttempts.get(lead.leadId) ?? 0;
    if (attempts >= MAX_RESOLVE_ATTEMPTS) return;
    const slug = linkedinSlug(lead.linkedinUrl);
    if (!slug) {
      this.log(`[lead] ${lead.leadId} has no usable LinkedIn URL (${lead.linkedinUrl})`);
      this.resolveAttempts.set(lead.leadId, MAX_RESOLVE_ATTEMPTS);
      return;
    }
    this.resolveAttempts.set(lead.leadId, attempts + 1);
    try {
      const profile = await this.deps.unipile.getProfile(slug);
      const duplicate = this.deps.store.findLeadByProviderId(profile.provider_id);
      if (duplicate && duplicate.leadId !== lead.leadId) {
        this.log(`[lead] ${lead.leadId} is the same person as ${duplicate.leadId}; keeping both, tracking ${duplicate.leadId}`);
        return;
      }
      const updated = { ...lead, providerId: profile.provider_id, updatedAt: this.now() };
      this.deps.store.saveLead(updated);
      await this.writeCrm(lead.leadId, { providerId: updated.providerId, updatedAt: updated.updatedAt });
      this.log(`[lead] ${lead.leadId} resolved to ${profile.provider_id}`);
    } catch (err) {
      this.log(`[lead] could not resolve ${lead.leadId} (${slug}): ${(err as Error).message}`);
    }
  }

  // ---- CRM writes -------------------------------------------------------

  private async writeCrm(leadId: string, fields: Partial<Lead>): Promise<void> {
    try {
      await this.deps.crm.upsertLead({ ...fields, leadId });
      this.unsynced.delete(leadId);
    } catch (err) {
      // The local store already has the change; the next sync retries the write.
      this.unsynced.add(leadId);
      this.log(`[crm] write for ${leadId} failed, will retry on next sync: ${(err as Error).message}`);
    }
  }

  private async logEvent(
    lead: Lead,
    eventType: string,
    direction: "outbound" | "inbound" | "",
    messageId: string,
    oldStatus: string,
    newStatus: string,
  ): Promise<void> {
    try {
      await this.deps.crm.logEvent({ timestamp: this.now(), leadId: lead.leadId, eventType, direction, messageId, oldStatus, newStatus });
    } catch (err) {
      this.log(`[crm] could not log event for ${lead.leadId}: ${(err as Error).message}`);
    }
  }

  // ---- plumbing ---------------------------------------------------------

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task);
    // Keep the chain alive even if a task fails.
    this.queue = run.catch((err) => this.log(`[tracker] task failed: ${(err as Error).stack ?? err}`));
    return run;
  }

  private inBackground(task: () => Promise<void>): void {
    const p = task().catch((err) => this.log(`[tracker] background task failed: ${(err as Error).message}`));
    this.background.add(p);
    void p.finally(() => this.background.delete(p));
  }
}

/** Everything the server owns, for re-pushing a lead after a failed write. */
function serverFields(lead: Lead): Partial<Lead> {
  const { name: _n, company: _c, linkedinUrl: _u, ...rest } = lead;
  return rest;
}
