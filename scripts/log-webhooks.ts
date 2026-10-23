// Milestone 0: a bare server that saves every Unipile webhook body to
// fixtures/raw/ so we can read real payloads before trusting the normalizer.
//
//   npm run log-webhooks
//   ngrok http 3000
//   npm run register-webhook
//
// Then send, read and reply to a message with a friend. fixtures/raw/ is in
// .gitignore because it holds real names and messages; anonymize a copy
// before committing it to fixtures/real/.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { isAuthorized } from "../src/webhooks/unipile.js";

const port = Number(process.env.PORT ?? 3000);
const secret = process.env.WEBHOOK_SECRET;
const authHeader = process.env.WEBHOOK_AUTH_HEADER ?? "Unipile-Auth";
const outDir = path.resolve("fixtures/raw");
fs.mkdirSync(outDir, { recursive: true });

const app = express();
let count = 0;

app.post("/webhooks/unipile", express.raw({ type: "*/*", limit: "2mb" }), (req, res) => {
  res.sendStatus(200);
  const text = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep the raw text
  }
  const event = (body as { event?: string })?.event ?? "unknown";
  const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${++count}-${event}.json`);
  const record = {
    receivedAt: new Date().toISOString(),
    authOk: secret ? isAuthorized(req.get(authHeader), secret) : null,
    headers: { "content-type": req.get("content-type") ?? null },
    body,
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(`[log-webhooks] ${event} -> ${path.relative(process.cwd(), file)}`);
});

app.listen(port, () => console.log(`[log-webhooks] listening on http://localhost:${port}/webhooks/unipile`));
