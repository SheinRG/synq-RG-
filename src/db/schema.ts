// SQLite schema. The server's own memory: raw webhooks, messages, and lead state.

export const SCHEMA = `
-- Every webhook we accepted, exactly as received. Append only.
-- The unique dedupe key is how we process each event once.
CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload TEXT NOT NULL
);

-- Messages we have seen, so a read or delivery receipt can be tied back to
-- the message it refers to (and its direction and send time).
CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  lead_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  sent_at TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_id, sent_at);

-- Current state of each lead. Mirrors the Leads tab so we never have to read
-- the Sheet while handling a webhook.
CREATE TABLE IF NOT EXISTS leads (
  lead_id TEXT PRIMARY KEY,
  provider_id TEXT,
  chat_id TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS leads_provider ON leads (provider_id);
CREATE INDEX IF NOT EXISTS leads_chat ON leads (chat_id);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
