// Express app and routes. Kept apart from startup so tests can import it.

import fs from "node:fs";
import path from "node:path";
import express from "express";
import type { Config } from "./config.js";
import type { LeadTracker } from "./tracker.js";
import { isAuthorized } from "./webhooks/unipile.js";

export function createApp(tracker: LeadTracker, config: Config): express.Express {
  const { env } = config;
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ ok: true, demoMode: env.DEMO_MODE });
  });

  // Webhooks created through the Unipile API may arrive without a JSON
  // content type, so read the raw body and parse it ourselves.
  app.post("/webhooks/unipile", express.raw({ type: "*/*", limit: "2mb" }), (req, res) => {
    if (!isAuthorized(req.get(env.WEBHOOK_AUTH_HEADER), env.WEBHOOK_SECRET)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "");
    } catch {
      // Answer 200 anyway: a malformed body will not get better on retry.
      console.warn("[webhook] body was not valid JSON, skipped");
      res.sendStatus(200);
      return;
    }
    if (env.LOG_WEBHOOKS) appendRawLog(body);

    // Unipile retries anything that is not a 200 within 30 seconds, so answer
    // first and do the work afterwards. Processing is idempotent.
    res.sendStatus(200);
    tracker.handleWebhook(body).catch(() => {
      /* already logged by the tracker */
    });
  });

  // Manual triggers, handy while recording the demo. Same secret as webhooks.
  const admin = express.Router();
  admin.use((req, res, next) => {
    if (isAuthorized(req.get("x-admin-secret"), env.WEBHOOK_SECRET)) return next();
    res.status(401).json({ error: "unauthorized" });
  });
  admin.post("/sync", async (_req, res) => {
    await tracker.syncLeads();
    res.json({ ok: true });
  });
  admin.post("/follow-up-check", async (_req, res) => {
    await tracker.runFollowUpCheck();
    res.json({ ok: true });
  });
  app.use("/admin", admin);

  return app;
}

function appendRawLog(body: unknown): void {
  const file = path.resolve("logs/webhooks.ndjson");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ receivedAt: new Date().toISOString(), body }) + "\n");
}
