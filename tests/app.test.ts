import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { fixture, setup } from "./helpers.js";

const SECRET = "test-secret-0123456789";
const config = loadConfig({
  UNIPILE_DSN: "api1.unipile.com:13111",
  UNIPILE_API_KEY: "key",
  UNIPILE_ACCOUNT_ID: "dfXlh46vQYCsMbVarumWlg",
  WEBHOOK_SECRET: SECRET,
  GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
  SHEET_ID: "sheet",
});

let server: Server | undefined;
afterEach(() => server?.close());

async function start() {
  const ctx = setup();
  server = createApp(ctx.tracker, config).listen(0);
  await new Promise((r) => server!.once("listening", r));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return { ...ctx, base };
}

describe("POST /webhooks/unipile", () => {
  it("rejects requests without the shared secret", async () => {
    const { base, crm, tracker } = await start();
    const res = await fetch(`${base}/webhooks/unipile`, {
      method: "POST",
      body: JSON.stringify(fixture("message_received.outbound")),
    });
    expect(res.status).toBe(401);
    await tracker.idle();
    expect(crm.leads).toHaveLength(0);
  });

  it("answers 200 and processes the event, even without a JSON content type", async () => {
    const { base, crm, tracker } = await start();
    const res = await fetch(`${base}/webhooks/unipile`, {
      method: "POST",
      headers: { "Unipile-Auth": SECRET, "content-type": "text/plain" },
      body: JSON.stringify(fixture("message_received.outbound")),
    });
    expect(res.status).toBe(200);
    await tracker.idle();
    expect(crm.get("L-0001")?.status).toBe("Message sent");
  });

  it("answers 200 to a body that is not JSON so Unipile does not retry it", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/webhooks/unipile`, {
      method: "POST",
      headers: { "Unipile-Auth": SECRET },
      body: "not json",
    });
    expect(res.status).toBe(200);
  });
});

describe("config", () => {
  it("reads the threshold as minutes in demo mode", () => {
    const demo = loadConfig({ ...process.env, ...minimalEnv(), DEMO_MODE: "true", NOT_REPLIED_AFTER_DAYS: "2" });
    expect(demo.rules.notRepliedAfterMs).toBe(2 * 60_000);
    expect(demo.schedulerCron).toBe("* * * * *");
  });

  it("defaults to 3 days and 2 follow-ups", () => {
    expect(config.rules).toEqual({ notRepliedAfterMs: 3 * 24 * 60 * 60 * 1000, maxFollowUps: 2 });
  });

  it("explains which variables are missing", () => {
    expect(() => loadConfig({})).toThrow(/UNIPILE_DSN/);
  });
});

function minimalEnv() {
  return {
    UNIPILE_DSN: "d",
    UNIPILE_API_KEY: "k",
    UNIPILE_ACCOUNT_ID: "a",
    WEBHOOK_SECRET: SECRET,
    GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
    SHEET_ID: "s",
  };
}
