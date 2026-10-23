// Time based jobs. The follow-up check normally runs once a day; in demo mode
// it runs every minute (and the threshold is read as minutes, see config.ts).

import cron from "node-cron";
import type { LeadTracker } from "../tracker.js";

export function startScheduler(
  tracker: LeadTracker,
  opts: { followUpCron: string; leadSyncCron: string },
): () => void {
  const jobs = [
    cron.schedule(opts.followUpCron, () => {
      tracker.runFollowUpCheck().catch((err) => console.error("[scheduler] follow-up check failed:", err));
    }),
    cron.schedule(opts.leadSyncCron, () => {
      tracker.syncLeads().catch((err) => console.error("[scheduler] lead sync failed:", err));
    }),
  ];
  console.log(`[scheduler] follow-up check "${opts.followUpCron}", lead sync "${opts.leadSyncCron}"`);
  return () => jobs.forEach((job) => job.stop());
}
