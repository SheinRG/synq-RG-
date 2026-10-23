// Startup: build the pieces, start the server and the scheduler.

import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { Store } from "./db/index.js";
import { GoogleSheetsCrm, loadServiceAccount } from "./crm/googleSheets.js";
import { UnipileClient } from "./services/unipile.js";
import { DisabledClassifier, LlmClassifier } from "./ai/classifier.js";
import { LeadTracker } from "./tracker.js";
import { startScheduler } from "./engine/scheduler.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { env } = config;

  const store = new Store(env.DATABASE_PATH);
  const crm = new GoogleSheetsCrm(env.SHEET_ID, loadServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON), {
    next: () => store.nextLeadId(),
    bumpTo: (n) => store.bumpLeadSequence(n),
  });
  const unipile = new UnipileClient(env.UNIPILE_DSN, env.UNIPILE_API_KEY, env.UNIPILE_ACCOUNT_ID);
  const classifier = env.XAI_API_KEY
    ? new LlmClassifier(env.XAI_API_KEY, env.LLM_BASE_URL, env.LLM_MODEL)
    : new DisabledClassifier();
  if (!env.XAI_API_KEY) console.warn("[startup] XAI_API_KEY not set; replies will be marked Unclassified");

  const tracker = new LeadTracker({
    store,
    crm,
    unipile,
    classifier,
    rules: config.rules,
    accountId: env.UNIPILE_ACCOUNT_ID,
  });

  const app = createApp(tracker, config);
  const server = app.listen(env.PORT, () => {
    console.log(`[startup] listening on http://localhost:${env.PORT}`);
    console.log(`[startup] webhook URL: ${env.PUBLIC_BASE_URL ?? "<your public url>"}/webhooks/unipile`);
    if (env.DEMO_MODE) {
      console.log(`[startup] DEMO_MODE: Follow-up due after ${env.NOT_REPLIED_AFTER_DAYS} minute(s)`);
    }
  });

  await tracker.syncLeads().catch((err) => console.error("[startup] initial lead sync failed:", err.message));
  const stopScheduler = startScheduler(tracker, { followUpCron: config.schedulerCron, leadSyncCron: config.leadSyncCron });

  const shutdown = async () => {
    console.log("[shutdown] finishing queued work");
    stopScheduler();
    server.close();
    await tracker.idle();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
