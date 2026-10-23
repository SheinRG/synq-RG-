# LinkedIn DM Lead Tracker: Process and Outcome

Raghav Gangwar, October 2026

## The problem

Salespeople message leads on LinkedIn, but nobody keeps the CRM up to date
with what happened next. Was the message delivered? Did they open it? Did they
reply, and was the reply a yes or a no? Who needs a nudge today?

The goal was a LinkedIn automation that plugs into a CRM and keeps each lead's
status current (message sent, opened, replied, not replied) without changing
how salespeople work. They keep using LinkedIn as usual. The CRM updates itself.

## Why the official LinkedIn API does not work

LinkedIn's messaging API is limited to approved partners and there is no public
way to apply. There is no self serve way to read or send DMs, so any working
solution has to read the inbox some other way.

## Options compared

| Option | Detects Opened | Detects Replied | Account risk | Verdict |
| --- | --- | --- | --- | --- |
| Unipile API | Yes | Yes, real time | Medium | **Chosen** |
| Chrome extension reading our own inbox | Yes, via the Seen tag | Yes | Lower | Backup if Unipile fails |
| Parsing LinkedIn notification emails in Gmail | No | Mostly | None | Zero risk fallback |
| Outreach tools (HeyReach, Expandi) plus Zapier | Yes | Yes | Medium | Rejected: configuring, not building |
| Headless Playwright bot | Yes | Yes | High | Rejected: ban risk |
| Official LinkedIn API | No | No | n/a | Not possible |

Unipile won because it connects a real LinkedIn account and pushes webhooks for
new messages (ours and theirs), read receipts and delivery receipts. That covers
every status we need, in real time, with a 7 day free trial.

An LLM cannot see the inbox, so it is not a way to get the data. It is good at
reading text we hand it, so Grok is used for one job: labelling replies and
drafting follow-ups.

A Google Sheet plays the CRM because a reviewer can open a link and watch rows
change. All CRM writes go through one small adapter, so HubSpot or Zoho can
replace the sheet later without touching the rest.

## Architecture

```
LinkedIn <-> Unipile --webhooks--> Node/Express server
                                    |- webhook handler  (secret check, dedupe, 200 fast)
                                    |- events store     (SQLite, append only)
                                    |- status engine    (pure functions, unit tested)
                                    |- scheduler        (Follow-up due / Not replied)
                                    |- classifier       (Grok)
                                    '- CRM adapter -->  Google Sheet
```

A few choices worth calling out:

* **Answer first, work after.** Unipile retries any webhook that does not get a
  200 within 30 seconds, so the server answers immediately and processes the
  event afterwards.
* **Process each event once.** Every webhook is stored in SQLite under a key
  made of the event name and the message id. A retry or duplicate is skipped.
* **One event at a time.** Events go through a small queue, so two webhooks for
  the same lead can never race each other.
* **The AI never blocks a status change.** The row moves to Replied first. The
  label lands a moment later. If Grok fails, times out or returns bad JSON, the
  category is set to Unclassified and everything carries on.
* **The sheet is written, not read, during events.** The server keeps its own
  copy of each lead in SQLite. This avoids rate limits and lets the server
  keep working if Google is briefly down; failed writes are retried on the
  next sync.
* **Humans send, the system suggests.** Nothing is ever sent to LinkedIn. Drafts
  only go into the Suggested Follow-up column.

## Status rules

Status always reflects the latest turn of the conversation, and it never moves
backwards unless we send a new message.

| Trigger | Condition | New status |
| --- | --- | --- |
| Lead row added | none | Not contacted |
| We send a message | any | Message sent |
| Delivery receipt for our latest message | status is Message sent | Delivered |
| Read receipt for our latest message | status is Message sent or Delivered | Opened |
| Lead sends a message | any | Replied (plus AI label) |
| Daily check, no reply after N days | Message sent, Delivered or Opened | Follow-up due, or Not replied after the last follow-up |

Defaults are 3 days and 2 follow-ups. For the demo the 3 days become 3 minutes.

The rules are one pure function with a unit test for every row, including the
awkward cases: a read receipt that arrives after we already sent a newer
message, a delivery receipt that arrives after the read receipt, and the same
webhook arriving twice. None of them move the status backwards.

## Known limitations

* **Opened needs read receipts.** If the lead has them turned off, the lead
  stays at Delivered.
* **Unipile is unofficial**, so there is some risk of account restrictions.
  Volume stays low and the demo only uses friends.
* **The Unipile trial is 7 days.** Production needs a paid plan or the Chrome
  extension route.
* **Google Sheets has rate limits.** Each status change is a few calls (find
  the row, one batched write, one log line). A real CRM replaces the sheet at scale.
* **Only conversations after the account was connected are tracked.**
* **Payload details.** Unipile documents one example webhook payload. The
  parser follows it and tolerates extra or missing fields. Real captures from
  the setup step are the final word if anything differs.

## Path to HubSpot or Zoho

The rest of the system only talks to four methods: `listLeads`, `upsertLead`,
`updateStatus` and `logEvent`. For HubSpot, leads become contacts with a few
custom properties (tracker id, DM status, reply category, summary, timestamps),
`logEvent` becomes a note on the contact, and the new adapter is wired in with
a one line change. Zoho maps the same way onto its Leads module. The README has
the method by method mapping.

## Outcome

* A Node and TypeScript server that turns LinkedIn DM activity into live CRM
  status, with AI labels on replies and drafted follow-ups.
* 98 automated tests covering the status rules, payload parsing, the full
  pipeline, recovery from failed Sheet writes, the Sheets adapter, the AI
  fallback and the HTTP layer.
* A live Google Sheet with Leads, Events and Summary tabs.
* A demo video showing a row go from Message sent to Opened to Replied with an
  AI label, and an unanswered lead flip to Follow-up due.
