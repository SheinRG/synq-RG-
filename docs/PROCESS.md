# LinkedIn DM Lead Tracker: Process and Outcome

Raghav Gangwar, October 2026

## The problem

Salespeople message leads on LinkedIn, but nobody keeps the CRM up to date
with what happened next. Did they open it? Did they reply, and was the reply a
yes or a no? Who needs a nudge today?

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
| Unipile API | Yes | Yes, real time | Medium | Built first, then dropped (see below) |
| Chrome extension reading our own inbox | Yes, via the Seen marker | Yes | Lower | **Chosen** |
| Parsing LinkedIn notification emails in Gmail | No | Mostly | None | Zero risk fallback |
| Outreach tools (HeyReach, Expandi) plus Zapier | Yes | Yes | Medium | Rejected: configuring, not building |
| Headless Playwright bot | Yes | Yes | High | Rejected: ban risk |
| Official LinkedIn API | No | No | n/a | Not possible |

## The pivot: Unipile first, then a Chrome extension

The first version used Unipile, a service that connects a real LinkedIn account
and sends webhooks for new messages, read receipts and deliveries. I built it
fully: a Node and TypeScript server with webhook handling, a SQLite event
store, a status engine, a Grok classifier and a Google Sheets adapter, with 98
tests. It is kept in the repo history under the `unipile-version` tag.

Two things changed my mind:

1. **The Unipile account was flagged and suspended soon after first use.** That
   is exactly the account risk the brief warned about, and it showed up on day one.
2. **Setup was too heavy for a reviewer.** Running it meant about 11 keys and
   settings: a Unipile trial, a Google Cloud service account, ngrok, a webhook
   registration, and a server that has to stay up.

The Chrome extension was already the planned backup, so I switched to it. It
reads the LinkedIn Messages page the user already has open and never acts on
LinkedIn by itself. The backend moved into Google Apps Script, the free
JavaScript that lives inside the Sheet. There is no server and no service
account. Setup went from about 11 values to 2: the Apps Script web app URL
pasted into the extension, and the Grok key.

| | Unipile version | Extension version |
| --- | --- | --- |
| Keys and settings | About 11 | 2 |
| Server to run | Yes, plus ngrok | No |
| Account risk | Got suspended | Lower: reads our own screen, never sends |
| Cost | Trial, then paid | Free |
| Reviewer setup | Long | Load extension, paste URL |

The most valuable part of the first version carried over: the status engine.
It is the same pure `nextState(lead, event)` function with the same guards
and tests, now inside Apps Script.

## Architecture

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

A few choices worth calling out:

* **Compare, don't count.** The extension sends what it sees, not events. The
  script compares the latest message on screen with what the row already says,
  and only a real difference becomes an event. Sending the same screen twice
  changes nothing, which replaces the webhook dedupe of the first version.
* **One clock.** LinkedIn shows times like "2:15 PM", which are too coarse to
  order messages safely. Every event uses the time the extension saw it, so
  a reply can never look older than the message it answers.
* **The list and the open thread agree.** The conversation list shows a
  shortened preview while the open thread shows the full text. Messages are
  compared on their opening characters so the same message is never counted twice.
* **The AI never blocks a status change.** The row moves to Replied first.
  The label lands a moment later. If Grok fails or returns bad JSON, the
  category is Unclassified and everything carries on.
* **Tracking starts at install.** On its first run the extension records what
  is already in the inbox. An old chat with someone in the Sheet becomes the
  starting point instead of a fake "reply", and only conversations that change
  after that can add new rows. This keeps an old inbox from flooding the Sheet.
* **Humans send, the system suggests.** The extension only reads the page. It
  never clicks, types or sends. Drafts go to the Suggested Follow-up column.

## Status rules

Status always reflects the latest turn of the conversation, and it never moves
backwards unless we send a new message.

| Trigger | Condition | New status |
| --- | --- | --- |
| Lead row added | none | Not contacted |
| A new message from us appears | any | Message sent |
| Seen marker on our latest message | status is Message sent | Opened |
| A new message from the lead appears | any | Replied (plus AI label) |
| Timer, no reply after N days | Message sent or Opened | Follow-up due, or Not replied after the last follow-up |

Defaults are 3 days and 2 follow-ups. Demo mode reads the 3 days as 3 minutes.

The brief also had a Delivered status. LinkedIn's web page does not show a
separate delivered marker, so the extension cannot see it and the status was
removed rather than left in as a step that never happens.

## Known limitations

* **It only syncs while LinkedIn is open in Chrome.** Messages that arrive
  while the browser is closed are picked up the next time Messages is opened,
  but their times are when the extension saw them, so a follow-up can be
  flagged a little later than it should be.
* **It depends on LinkedIn's page layout.** If LinkedIn changes its markup,
  the selectors need updating. They all live in one file
  (`extension/selectors.js`), and the popup has a "Check this page" button
  that shows which ones still match.
* **Opened is partial.** It is caught when a thread is open and the Seen
  marker is there, and it still needs the lead to have read receipts on.
  Otherwise the lead stays at Message sent until they reply.
* **Lower risk, not zero.** Reading your own screen is still scraping in the
  strict sense. It makes no extra requests to LinkedIn, but it is not an
  approved integration.
* **The web app URL is the key.** Anyone with the URL could post to it, so
  it should be treated like a password. It can only update leads and add rows.
* **Google Sheets is not a real CRM at scale.** Apps Script has daily quotas
  and the Sheet slows down with many thousands of rows.

## Path to HubSpot or Zoho

The rest of the script only talks to four methods: `listLeads`, `upsertLead`,
`updateStatus` and `logEvent`. For HubSpot, leads become contacts with a few
custom properties (tracker id, DM status, reply category, summary,
timestamps), `logEvent` becomes a note on the contact, and the calls go
through `UrlFetchApp` with a private app token. Zoho maps the same way onto
its Leads module. The README has the method by method mapping.

## Outcome

* A Chrome extension and a Google Apps Script that turn LinkedIn DM activity
  into live CRM status, with AI labels on replies and drafted follow-ups.
* 204 automated tests for the status rules, the screen comparison, matching,
  the Sheets adapter, the AI fallback, the web app and the extension's page
  parser. They run in Node against a fake Sheet and sample LinkedIn HTML.
* A live Google Sheet with Leads, Events and Summary tabs.
* A demo video showing a row go from Message sent to Opened to Replied with an
  AI label, and an unanswered lead flip to Follow-up due.
