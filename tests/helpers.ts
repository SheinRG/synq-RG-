import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/db/index.js";
import { MemoryCrm } from "../src/crm/memory.js";
import { LeadTracker } from "../src/tracker.js";
import { DAY_MS } from "../src/engine/status.js";
import type { Classification, ReplyClassifier } from "../src/ai/classifier.js";
import type { ThreadMessage, UnipileApi, UnipileProfile } from "../src/services/unipile.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** A fresh copy of a payload from fixtures/docs-example. */
export function fixture(name: string): Record<string, unknown> {
  const file = path.join(here, "..", "fixtures", "docs-example", `${name}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

export const ACCOUNT_ID = "dfXlh46vQYCsMbVarumWlg";
export const LEAD_PROVIDER_ID = "AA1212sqqsMQBODyLwZrRcgYhrkCafURGqva0U4E";
export const CHAT_ID = "R8J-xM9WX7eoHLp6gSVtWQ";

export class FakeUnipile implements UnipileApi {
  profiles = new Map<string, UnipileProfile>();
  threads = new Map<string, ThreadMessage[]>();
  profileCalls: string[] = [];

  async getProfile(identifier: string): Promise<UnipileProfile> {
    this.profileCalls.push(identifier);
    const p = this.profiles.get(identifier);
    if (!p) throw new Error(`404 profile ${identifier}`);
    return p;
  }

  async getRecentMessages(chatId: string): Promise<ThreadMessage[]> {
    return this.threads.get(chatId) ?? [];
  }
}

export class FakeClassifier implements ReplyClassifier {
  result: Classification = {
    category: "Interested",
    confidence: 0.9,
    summary: "Open to a call on Monday",
    suggestedReply: "Great, does 11am Monday work?",
  };
  draft = "Hi, just floating this back up. Worth a quick chat?";
  seenThreads: ThreadMessage[][] = [];

  async classify(_lead: unknown, thread: ThreadMessage[]): Promise<Classification> {
    this.seenThreads.push(thread);
    return this.result;
  }

  async draftFollowUp(): Promise<string> {
    return this.draft;
  }
}

export function setup(opts: { now?: string } = {}) {
  let now = opts.now ?? "2026-10-24T15:00:00.000Z";
  const store = new Store(":memory:");
  const crm = new MemoryCrm({ next: () => store.nextLeadId(), bumpTo: (n) => store.bumpLeadSequence(n) });
  const unipile = new FakeUnipile();
  const classifier = new FakeClassifier();
  const logs: string[] = [];
  const tracker = new LeadTracker({
    store,
    crm,
    unipile,
    classifier,
    rules: { notRepliedAfterMs: 3 * DAY_MS, maxFollowUps: 2 },
    accountId: ACCOUNT_ID,
    now: () => now,
    log: (m) => logs.push(m),
  });
  return {
    store,
    crm,
    unipile,
    classifier,
    tracker,
    logs,
    setNow: (iso: string) => {
      now = iso;
    },
    /** Deliver a webhook and wait until all resulting work is done. */
    deliver: async (payload: unknown) => {
      await tracker.handleWebhook(payload);
      await tracker.idle();
    },
  };
}
