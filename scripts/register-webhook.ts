// Registers our webhook with Unipile for the messaging events we need.
//
//   npm run register-webhook            # uses PUBLIC_BASE_URL from .env
//   npm run register-webhook -- --list  # show existing webhooks
//
// Per the Unipile docs: message_received is the only default event, so read
// and delivered must be requested explicitly, and webhooks created through
// the API do not send a JSON content type unless we add the header ourselves.

import "dotenv/config";
import { requireEnv } from "../src/config.js";
import { UnipileClient } from "../src/services/unipile.js";

const client = new UnipileClient(requireEnv("UNIPILE_DSN"), requireEnv("UNIPILE_API_KEY"), requireEnv("UNIPILE_ACCOUNT_ID"));

async function main() {
  if (process.argv.includes("--list")) {
    console.log(JSON.stringify(await client.listWebhooks(), null, 2));
    return;
  }
  const base = requireEnv("PUBLIC_BASE_URL").replace(/\/+$/, "");
  const result = await client.createWebhook({
    request_url: `${base}/webhooks/unipile`,
    name: "linkedin-lead-tracker",
    source: "messaging",
    events: ["message_received", "message_read", "message_delivered"],
    account_ids: [requireEnv("UNIPILE_ACCOUNT_ID")],
    headers: [
      { key: "Content-Type", value: "application/json" },
      { key: process.env.WEBHOOK_AUTH_HEADER ?? "Unipile-Auth", value: requireEnv("WEBHOOK_SECRET") },
    ],
  });
  console.log(`Webhook created: ${result.webhook_id} -> ${base}/webhooks/unipile`);
  console.log("If your ngrok URL changes, delete the old webhook in the Unipile dashboard and run this again.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
