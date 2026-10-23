# LinkedIn DM Lead Tracker

Salespeople keep messaging leads on LinkedIn the normal way. This server watches
those conversations and keeps each lead's status up to date in a Google Sheet
that acts as the CRM:

`Not contacted` → `Message sent` → `Delivered` → `Opened` → `Replied`,
and `Follow-up due` / `Not replied` when a lead goes quiet.

When a lead replies, an LLM (Grok) labels the reply (Interested, Not interested,
Question, Later, Other), writes a one line summary and suggests a next message.
Nothing is ever sent automatically. The system observes and suggests; people send.

There is no custom frontend. The Sheet is the user interface.

## How it works

```
LinkedIn <-> Unipile --webhooks--> Node/Express server
                                    |- webhook handler   (shared secret check, dedupe, answer 200 fast)
                                    |- events store      (SQLite, append only)
                                    |- status engine     (pure functions, unit tested)
                                    |- scheduler         (node-cron: Follow-up due / Not replied)
                                    |- classifier        (Grok: labels replies, drafts follow-ups)
                                    '- CRM adapter  -->  Google Sheet (Leads, Events, Summary tabs)
```

1. Someone adds a row to the **Leads** tab with a name, company and LinkedIn URL.
   The server gives it a Lead ID, sets `Not contacted` and looks up the person's
   LinkedIn id through Unipile.
2. They send a DM from LinkedIn as usual. Unipile sends a `message_received`
   webhook. The sender is our own account, so the lead becomes `Message sent`.
3. `message_delivered` makes it `Delivered`, and `message_read` makes it `Opened`.
4. When the lead answers, it becomes `Replied`. The last few messages of the
   thread go to Grok, which fills in Reply Category, Reply Summary and
   Suggested Follow-up.
5. A scheduled job moves leads with no answer after `NOT_REPLIED_AFTER_DAYS` to
   `Follow-up due` (with a drafted follow-up), or to `Not replied` once
   `MAX_FOLLOWUPS` follow-ups have been sent.

Chats with someone who is not in the sheet get a new row with `Source = Auto-added`.

### Status rules

Status always reflects the latest turn of the conversation, and it never moves
backwards unless we send a new message.

| Trigger | Condition | New status | Side effects |
| --- | --- | --- | --- |
| Lead row added | none | Not contacted | Resolve provider ID |
| Outbound message | any | Message sent | Set Last Outbound At, clear Opened At, count a follow-up if the status was Follow-up due |
| Delivery receipt for our latest message | status is Message sent | Delivered | none |
| Read receipt for our latest message | status is Message sent or Delivered | Opened | Set Opened At |
| Inbound message | any | Replied | Set Last Inbound At and snippet, ask Grok for a label |
| Scheduled check | waiting on a reply for longer than the threshold | Follow-up due, or Not replied when follow-ups are used up | Ask Grok for a follow-up draft |

A few extra guards keep the status honest when webhooks arrive late or twice:

* Each webhook is processed once. The dedupe key is the event name plus the message id.
* Receipts for an older message than our latest one are ignored.
* A message older than the latest one in the same direction is ignored.
* A read receipt on the lead's own message (that is us reading it) is ignored.

All of this lives in `src/engine/status.ts` as one pure function,
`nextState(lead, event)`, with a test for every row of the table in
`tests/engine.test.ts`.

## Setup

You need Node 20 or newer.

```bash
npm install
cp .env.example .env    # then fill it in, see below
npm test                # 85 tests, no network needed
```

### 1. Unipile

1. Start the free trial at https://dashboard.unipile.com/signup (7 days, no card).
2. Connect your LinkedIn account in the dashboard.
3. Copy the DSN, an API key and the account id into `.env`.

### 2. Google Sheet

1. In Google Cloud, create a service account and download its JSON key.
   Enable the Google Sheets API for the project.
2. Create an empty Google Sheet and share it with the service account email
   as an Editor.
3. Put the key path in `GOOGLE_SERVICE_ACCOUNT_JSON` and the sheet id (the long
   part of the URL) in `SHEET_ID`.
4. Run `npm run setup-sheet`. It creates the Leads, Events and Summary tabs,
   the headers, the Summary formulas and the status colors.

### 3. LLM

Put your xAI key in `XAI_API_KEY` and run `npm run check-llm`. It lists the
models your key can use and labels a sample reply. If the model in `LLM_MODEL`
is not in the list, pick one that is.

To use Groq instead, change only two lines:
`LLM_BASE_URL=https://api.groq.com/openai/v1` and `LLM_MODEL=openai/gpt-oss-20b`.

Without a key the tracker still works; replies are marked `Unclassified`.

### 4. Run it

```bash
npm run dev                 # starts the server on PORT
ngrok http 3000             # in another terminal
# put the ngrok https URL in PUBLIC_BASE_URL, then:
npm run register-webhook    # tells Unipile where to send events
```

Add a lead to the sheet, message them on LinkedIn, and watch the row change.

For the demo, set `DEMO_MODE=true`. The follow-up threshold is then read as
minutes instead of days and the check runs every minute, so `Follow-up due`
shows up on video.

### Useful endpoints

| Route | What it does |
| --- | --- |
| `GET /health` | Liveness check |
| `POST /webhooks/unipile` | Where Unipile sends events. Needs the secret header. |
| `POST /admin/sync` | Pick up new sheet rows now. Header `x-admin-secret: <WEBHOOK_SECRET>` |
| `POST /admin/follow-up-check` | Run the Follow-up due check now. Same header. |

## Environment variables

| Variable | Purpose |
| --- | --- |
| `UNIPILE_DSN` | Unipile API host, like `api8.unipile.com:13851` |
| `UNIPILE_API_KEY` | Unipile access token |
| `UNIPILE_ACCOUNT_ID` | The connected LinkedIn account. Events for other accounts are ignored. |
| `WEBHOOK_SECRET` | Shared secret Unipile sends back on every webhook (16+ characters) |
| `WEBHOOK_AUTH_HEADER` | Header that carries the secret. Default `Unipile-Auth` |
| `PUBLIC_BASE_URL` | Public URL of this server, used by `register-webhook` |
| `XAI_API_KEY` | Grok key. Optional. |
| `LLM_BASE_URL` / `LLM_MODEL` | OpenAI compatible endpoint and model. Defaults to xAI. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Path to the service account key, or the JSON itself |
| `SHEET_ID` | Target spreadsheet |
| `NOT_REPLIED_AFTER_DAYS` | Default 3 |
| `MAX_FOLLOWUPS` | Default 2 |
| `DEMO_MODE` | `true` reads the threshold as minutes and checks every minute |
| `PORT` | Server port, default 3000 |
| `DATABASE_PATH` | SQLite file, default `./data/tracker.db` |
| `LOG_WEBHOOKS` | `true` also appends every raw webhook to `logs/webhooks.ndjson` |

## The Google Sheet

**Leads**: one row per lead. People fill Name, Company and LinkedIn URL. The
server owns every other column: Lead ID, Provider ID, Chat ID, Status, Reply
Category, Reply Summary, Last Message Snippet, Last Outbound At, Opened At,
Last Inbound At, Follow-up Count, Suggested Follow-up, Source, Updated At.

**Events**: an append only log of every status change (Timestamp, Lead ID,
Event Type, Direction, Message ID, Old Status, New Status).

**Summary**: formulas only. Leads per status, open rate, reply rate and reply
categories.

Rows are always found by Lead ID, never by position, so you can sort and
filter the sheet while the server runs. Everything is written as plain values,
so a message that starts with `=` never turns into a formula.

## Plugging in another CRM

Every CRM write goes through one small interface in `src/crm/adapter.ts`:

```ts
interface CrmAdapter {
  listLeads(): Promise<Lead[]>;
  upsertLead(lead: Partial<Lead> & { leadId: string }): Promise<void>;
  updateStatus(leadId: string, status: LeadStatus, fields: Partial<Lead>): Promise<void>;
  logEvent(event: LeadEvent): Promise<void>;
}
```

Google Sheets (`src/crm/googleSheets.ts`) is the real implementation.
`src/crm/memory.ts` is a 50 line version used by the tests, and the easiest
place to see the whole contract.

A HubSpot adapter would map the four methods like this:

| Method | HubSpot |
| --- | --- |
| `listLeads` | Search contacts (`POST /crm/v3/objects/contacts/search`) that have a LinkedIn URL. Store our Lead ID in a custom contact property such as `lead_tracker_id`. |
| `upsertLead` | Create or update the contact, matched on that custom property (or batch upsert with it as the unique id property). Name, company and LinkedIn URL map to standard properties. |
| `updateStatus` | Update custom properties: `linkedin_dm_status` (a dropdown with our 7 statuses), `reply_category`, `reply_summary`, the timestamps and the follow-up count. |
| `logEvent` | Create a Note (or a custom timeline event) on the contact with the old and new status. |

Then change one line in `src/index.ts` to build the new adapter instead of
`GoogleSheetsCrm`. Nothing else changes, because the engine and the tracker only
talk to the interface. Zoho works the same way with Leads module fields and Notes.

## Project layout

```
src/
  index.ts              startup: builds everything, starts server and scheduler
  app.ts                Express routes
  config.ts             env parsing and validation
  tracker.ts            the pipeline: webhook -> engine -> store -> CRM
  webhooks/unipile.ts   check the secret, normalize Unipile payloads
  services/unipile.ts   Unipile API client: profile lookup, recent messages, webhooks
  engine/status.ts      pure nextState() logic
  engine/scheduler.ts   Follow-up due / Not replied job and lead sync
  ai/classifier.ts      Grok calls and JSON validation
  crm/adapter.ts        the CrmAdapter interface
  crm/googleSheets.ts   Google Sheets implementation
  crm/memory.ts         in-memory implementation (tests)
  db/                   SQLite schema and queries
tests/                  engine, normalizer, pipeline, classifier and HTTP tests
scripts/
  log-webhooks.ts       milestone 0: save raw payloads to fixtures/raw/
  register-webhook.ts   create the Unipile webhook
  setup-sheet.ts        create tabs, headers, formulas and colors
  check-llm.ts          list models and test a classification
fixtures/               sample payloads (see fixtures/README.md)
docs/                   process doc and demo runbook
```

## Known limitations

* **Opened needs read receipts.** If the lead has read receipts turned off,
  LinkedIn never reports the read, so the lead stays at `Delivered`.
* **Unipile is unofficial.** It works by connecting a real account to
  LinkedIn's private interface, so there is some risk of account restrictions.
  Keep volume low. The demo only uses friends.
* **The Unipile trial lasts 7 days.** Production needs a paid plan, or the
  Chrome extension route described in the process doc.
* **Google Sheets has rate limits** (around 60 writes a minute per user). Each
  status change is one batched write. A real CRM replaces the sheet at scale.
* **Only new messages are tracked.** Unipile does not send webhooks for
  conversations that happened before the account was connected.
* **Webhook payloads come from the docs.** Unipile documents one example
  payload. The normalizer follows it and is forgiving about extra or missing
  fields. Check it against real captures (`npm run log-webhooks`) and adjust
  `src/webhooks/unipile.ts` if anything differs.
* **Group chats are ignored.** Only one to one conversations count as leads.
* The server keeps its own copy of lead state in SQLite and treats the sheet
  as the place it writes to. Editing server owned columns by hand is fine but
  will be overwritten on the next update for that lead.
