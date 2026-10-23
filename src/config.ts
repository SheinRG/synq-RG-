// Reads environment variables once, validates them, and exports a typed config.

import "dotenv/config";
import { z } from "zod";
import { DAY_MS, type Rules } from "./engine/status.js";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  UNIPILE_DSN: z.string().min(1),
  UNIPILE_API_KEY: z.string().min(1),
  UNIPILE_ACCOUNT_ID: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(16, "use at least 16 characters"),
  WEBHOOK_AUTH_HEADER: z.string().default("Unipile-Auth"),
  PUBLIC_BASE_URL: z.string().optional(),

  XAI_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().default("https://api.x.ai/v1"),
  LLM_MODEL: z.string().default("grok-4.20-0309-non-reasoning"),

  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().min(1),
  SHEET_ID: z.string().min(1),

  NOT_REPLIED_AFTER_DAYS: z.coerce.number().positive().default(3),
  MAX_FOLLOWUPS: z.coerce.number().int().min(0).default(2),
  DEMO_MODE: bool,

  PORT: z.coerce.number().int().default(3000),
  DATABASE_PATH: z.string().default("./data/tracker.db"),
  LOG_WEBHOOKS: bool,
});

export type Env = z.infer<typeof schema>;

export interface Config {
  env: Env;
  rules: Rules;
  /** Cron expression for the follow-up check. */
  schedulerCron: string;
  /** Cron expression for picking up new rows from the Sheet. */
  leadSyncCron: string;
}

/** For small scripts that only need one or two variables. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Add it to your .env file.`);
  return value;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment. Check your .env file:\n${problems}`);
  }
  const env = parsed.data;
  // In demo mode the "days" setting is read as minutes so the Follow-up due
  // transition can be shown on video.
  const unitMs = env.DEMO_MODE ? 60_000 : DAY_MS;
  return {
    env,
    rules: { notRepliedAfterMs: env.NOT_REPLIED_AFTER_DAYS * unitMs, maxFollowUps: env.MAX_FOLLOWUPS },
    schedulerCron: env.DEMO_MODE ? "* * * * *" : "0 9 * * *",
    leadSyncCron: env.DEMO_MODE ? "* * * * *" : "*/5 * * * *",
  };
}
