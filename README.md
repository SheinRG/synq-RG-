# LinkedIn DM Lead Tracker

Salespeople keep messaging leads on LinkedIn the normal way. A small Chrome
extension reads the LinkedIn Messages page they already have open, and a Google
Apps Script inside the Sheet keeps each lead's status up to date:

`Not contacted` → `Message sent` → `Opened` → `Replied`,
and `Follow-up due` / `Not replied` when a lead goes quiet.

When a lead replies, an LLM (Grok) labels the reply (Interested, Not interested,
Question, Later, Other), writes a one line summary and suggests a next message.
Nothing is ever sent automatically. The extension only reads the page; people send.

There is no server and no custom frontend. The Sheet is the user interface.

Setup takes two values: the Apps Script web app URL (pasted into the extension)
and an AI key (pasted into the Sheet).

> The first version of this project used Unipile webhooks and a Node server.
> It is kept under the `unipile-version` git tag. `docs/PROCESS.md` explains
> why it was replaced.

## How it works

```
LinkedIn Messages page (open in Chrome)
   |  content script reads what is on screen: names, previews, open thread, Seen marker
   v
Chrome extension  --POST JSON-->  Google Apps Script web app (bound to the Sheet)
                                    |- observe()      compares the screen with the row, finds new messages
                                    |- nextState()    pure status rules, unit tested
                                    |- CRM adapter    Leads, Events, Summary tabs
                                    |- classifier     Grok labels replies, drafts follow-ups
                                    '- timer          Follow-up due / Not replied checks
```

1. Someone adds a row to the **Leads** tab with a name, company and LinkedIn
   URL. The script gives it a Lead ID and sets `Not contacted`.
2. They message the lead on LinkedIn as usual. While the Messages page is open,
   the extension sees the new message in the conversation list and posts it to
   the script. The latest message is ours, so the lead becomes `Message sent`.
3. When that thread is open and LinkedIn shows the lead's Seen marker under our
   latest message, the lead becomes `Opened`.
4. When the lead answers, it becomes `Replied`. The last few messages go to
   Grok, which fills in Reply Category, Reply Summary and Suggested Follow-up.
5. A timer moves leads with no answer after `NOT_REPLIED_AFTER_DAYS` to
   `Follow-up due` (with a drafted follow-up), or to `Not replied` once
   `MAX_FOLLOWUPS` follow-ups have been sent.

Conversations are matched to rows by thread, then by LinkedIn profile URL, then
by name (only when exactly one row has that name). LinkedIn's messaging page
often links to a member id rather than the `/in/your-name` URL people paste,
so in practice the first match is usually by name, and the thread id is saved
on the row so every later match is exact. Credentials after a name
("Priya Sharma, MBA") are dropped before matching.

LinkedIn's conversation list has no links, so the thread id is only in the
address bar of the thread that is open. The extension learns it the first time
you open a conversation and remembers it by name, so from then on the list
alone is enough. A conversation you have not opened since installing is
not sent yet; the popup's **Check this page** lists those. Names shown twice
in the list are never looked up this way, only read while open.

**Tracking starts when the extension is installed.** On its first run the
extension records what is already in the inbox. An old chat with someone in
the Sheet is saved as the starting point, not counted as a reply, and only a
conversation that changes after that can add a new row (`Source = Auto-added`).
So an old inbox never floods the Sheet, and a friend you chatted with last
year does not show up as `Replied` before you have messaged them. Group chats
and sponsored InMail ads are ignored.

### Status rules

Status always reflects the latest turn of the conversation, and it never moves
backwards unless we send a new message.

| Trigger | Condition | New status | Side effects |
| --- | --- | --- | --- |
| Lead row added | none | Not contacted | Give it a Lead ID |
| A new message from us appears | any | Message sent | Set Last Outbound At, clear Opened At, count a follow-up if the status was Follow-up due |
| Seen marker on our latest message | status is Message sent | Opened | Set Opened At |
| A new message from the lead appears | any | Replied | Set Last Inbound At and snippet, ask Grok for a label |
| Timer | waiting on a reply for longer than the threshold | Follow-up due, or Not replied when follow-ups are used up | Ask Grok for a follow-up draft |

The extension does not send events. It sends what is on screen, and the
script's `observe()` compares that with what the row already says. Only a real
difference becomes an event, so sending the same screen twice changes nothing.
A few more guards keep the status honest:

* Every event uses the time the extension saw it, never LinkedIn's rough
  "2:15 PM" labels, so a reply can never look older than the message it answers.
* An event older than the latest one in the same direction is ignored. This
  covers two LinkedIn tabs posting at slightly different times.
* The conversation list shows a shortened preview and the open thread shows
  the full text. They are compared on their opening characters, so the same
  message is never counted twice.
* A Seen marker only counts when it sits on our latest message.

All of this is plain functions in `apps-script/Code.js` (`observe` and
`nextState`), with tests in `tests/apps-script/`.

## Setup

About ten minutes. You need Chrome and a Google account.

### 1. The Sheet and the script

1. Create an empty Google Sheet.
2. Open **Extensions > Apps Script**. Replace the contents of `Code.gs` with
   [`apps-script/Code.js`](apps-script/Code.js) and save.
   Optional: in Project Settings, tick "Show appsscript.json" and replace it
   with [`apps-script/appsscript.json`](apps-script/appsscript.json).
3. Reload the Sheet. A **Lead Tracker** menu appears. Click
   **Lead Tracker > Set up sheet** and allow the permissions Google asks for.
   This creates the Leads, Events and Summary tabs, the colors, the formulas
   and the daily timer.
4. Click **Lead Tracker > Set AI key** and paste your xAI (Grok) key. A Groq key
   (starting with `gsk_`) also works; the script picks the right endpoint.
   Without a key everything still works and replies are marked `Unclassified`.

### 2. Publish the script as a web app

1. In the Apps Script editor, click **Deploy > New deployment**.
2. Type: **Web app**. Execute as: **Me**. Who has access: **Anyone**.
3. Click **Deploy** and copy the web app URL (it ends in `/exec`).

"Anyone" is needed because the extension calls the URL without signing in to
Google. Treat the URL like a password: whoever has it can post updates to
your Sheet.

### 3. The Chrome extension

1. Get the code: clone this repo, or download it as a ZIP
   (https://github.com/SheinRG/synq-RG-/archive/refs/heads/main.zip) and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked** and pick the `extension/` folder.
3. Click the extension's icon, paste the web app URL (the one ending in
   `/exec`, not the Sheet's own link), click **Save**, then **Test
   connection**. It should show your Sheet's name.
4. Open https://www.linkedin.com/messaging/. That's it. Click **Check this
   page** in the popup to see what the extension can read.

### Try it

Add a friend to the Leads tab (name, company, LinkedIn URL), message them on
LinkedIn, and watch the row change.

For a demo, click **Lead Tracker > Demo mode on**. `NOT_REPLIED_AFTER_DAYS` is
then read as minutes and the check runs every minute, so `Follow-up due` shows
up on video. **Lead Tracker > Run follow-up check now** runs it straight away.

## Settings

All optional, in Apps Script **Project Settings > Script Properties**. The menu
sets the first and the last for you.

| Property | Purpose |
| --- | --- |
| `LLM_API_KEY` | Grok key from https://console.x.ai, or a Groq key. `GROK_API_KEY` and `XAI_API_KEY` also work. |
| `LLM_BASE_URL` / `LLM_MODEL` | Override the endpoint or model. Normally picked from the key. |
| `NOT_REPLIED_AFTER_DAYS` | Default 3 |
| `MAX_FOLLOWUPS` | Default 2 |
| `DEMO_MODE` | `true` reads the threshold as minutes and checks every minute |

## The extension

| File | What it does |
| --- | --- |
| `selectors.js` | Every LinkedIn selector, in one place. The only file to touch when LinkedIn changes its page. |
| `parser.js` | Pure functions that turn the page into plain data. Tested against sample HTML. |
| `tracking.js` | Which conversations changed since install ("fresh") and since the last send. |
| `content.js` | Watches the Messages page and sends only conversations that changed. |
| `background.js` | Posts to the web app, keeps failed sends for the next try, remembers the last result. |
| `shared.js` | Small helpers used by the background and the popup. |
| `popup.html` / `popup.js` | Paste the URL, test the connection, sync now, check the page. |

The popup's **Check this page** button shows how many elements each selector
found on the open LinkedIn tab and what the parser made of them. If a number
drops to zero after a LinkedIn update, that selector needs fixing.

### What the extension sends

```json
{
  "version": 1,
  "observedAt": "2026-10-26T10:00:00.000Z",
  "conversations": [
    {
      "threadId": "2-ABCxyz==",
      "threadUrl": "https://www.linkedin.com/messaging/thread/2-ABCxyz==/",
      "name": "Priya Sharma",
      "profileUrl": "https://www.linkedin.com/in/priya-sharma/",
      "isGroup": false,
      "fresh": true,
      "observedAt": "2026-10-26T10:00:00.000Z",
      "lastMessage": { "fromMe": true, "text": "Hi Priya, ..." },
      "seen": true,
      "messages": [{ "fromMe": true, "text": "Hi Priya, ..." }]
    }
  ]
}
```

`profileUrl`, `seen` and `messages` are only filled for the thread that is open.
`fresh` means the conversation changed after the extension was installed.
The extension never sends LinkedIn's displayed times; `observedAt` is the only clock.

## The Google Sheet

**Leads**: one row per lead. People fill Name, Company and LinkedIn URL; the
script never overwrites them and only fills a blank name or URL from LinkedIn.
The script owns every other column: Lead ID, Thread ID, Status, Reply Category,
Reply Summary, Last Message Snippet, Last Message From, Last Outbound At,
Opened At, Last Inbound At, Follow-up Count, Suggested Follow-up, Source,
Updated At.

**Events**: an append only log of every status change (Timestamp, Lead ID,
Event Type, Direction, Message ID, Old Status, New Status).

**Summary**: formulas only. Leads per status, open rate, reply rate and reply
categories.

Columns are found by their header text and rows by Lead ID, never by position,
so you can sort, filter and move columns while the tracker runs. Message text
is always written as plain text, so a message that starts with `=` never turns
into a formula.

## Plugging in another CRM

Every CRM read and write goes through one small object in `apps-script/Code.js`:

```js
const crm = createSheetCrm(spreadsheet);
crm.listLeads();                          // all leads; new rows get a Lead ID
crm.upsertLead({ leadId, ...fields });    // update by Lead ID, or create
crm.updateStatus(leadId, status, fields); // new status plus changed fields
crm.logEvent(event);                      // one line in the activity log
```

The status rules, matching and the timer only talk to these four methods.
A HubSpot version would map them like this, using `UrlFetchApp` and a HubSpot
private app token stored in Script Properties:

| Method | HubSpot |
| --- | --- |
| `listLeads` | Search contacts (`POST /crm/v3/objects/contacts/search`) that have a LinkedIn URL. Store our Lead ID in a custom contact property such as `lead_tracker_id`. |
| `upsertLead` | Create or update the contact, matched on that custom property. Name, company and LinkedIn URL map to standard properties. |
| `updateStatus` | Update custom properties: `linkedin_dm_status` (a dropdown with our statuses), `reply_category`, `reply_summary`, the timestamps and the follow-up count. |
| `logEvent` | Create a Note (or a custom timeline event) on the contact with the old and new status. |

Then build that object instead of `createSheetCrm` in the two entry points,
`doPost` and `runScheduledCheck`. Zoho works the same way with Leads module
fields and Notes.

## Tests

```bash
npm install
npm test
```

No network or Google account needed. The Apps Script tests run `Code.js` in
Node against an in-memory fake of the Sheet. The extension tests run the
parser against sample HTML shaped like the live Messages page, with made-up
names, and run the background worker against a fake `chrome` and `fetch`.
`tests/end-to-end.test.js` ties both together: it follows a lead from a
LinkedIn-shaped page through the extension and `doPost` to its Sheet row,
from Message sent to Opened to Replied.

## Project layout

```
apps-script/
  Code.js             the whole backend: web app, status rules, Sheet adapter, Grok, timer, menu
  appsscript.json     Apps Script manifest (scopes, web app settings)
extension/            the Chrome extension (Manifest V3, no build step)
tests/
  apps-script/        status rules, screen comparison, matching, Sheet adapter, classifier, web app
  extension/          page parser, change tracking, background worker, sample HTML
  end-to-end.test.js  a LinkedIn-shaped page all the way to a Sheet row
docs/                 process doc (PROCESS.md and PROCESS.pdf), demo runbook, pivot plan
```

## Known limitations

* **It only syncs while LinkedIn is open in Chrome.** Anything that happens
  while the browser is closed is picked up when Messages is opened again, with
  the time it was seen rather than the time it was sent.
* **It depends on LinkedIn's page layout.** The selectors were checked on the
  live page on 2026-10-26. If LinkedIn changes its markup, update
  `extension/selectors.js`. The popup's **Check this page** shows what broke.
* **A conversation is tracked once it has been opened** (see How it works).
  Messaging a lead opens their thread, so this mostly affects old chats.
* **Opened is partial.** It needs the thread to be open while the Seen marker
  is showing, and the lead must have read receipts on. Otherwise the lead stays
  at `Message sent` until they reply.
* **No Delivered status.** LinkedIn's web page has no separate delivered marker.
* **Lower risk, not zero.** The extension only reads a page you already have
  open and makes no requests to LinkedIn, but it is still reading LinkedIn's
  page, not an approved integration.
* **Google Sheets and Apps Script have quotas.** Fine for a sales team's DM
  volume; a real CRM replaces the Sheet at scale.
