# LinkedIn DM Lead Tracker: Process and Outcome

Raghav Gangwar, October 2026

## The problem

Salespeople message leads on LinkedIn, but the CRM never hears what happened
next. Did the lead open it? Reply? Say yes or no? Who needs a nudge today?

The goal: keep each lead's status in the CRM current (message sent, opened,
replied, not replied) without changing how salespeople work. They use LinkedIn
as usual, and the CRM updates itself.

## Why the official LinkedIn API does not work

LinkedIn's messaging API is limited to approved partners, with no public way to
apply. Nobody can read DMs through it on their own, so a working solution has
to read the inbox some other way.

## Options compared

| Option | Opened | Replied | Account risk | Verdict |
| --- | --- | --- | --- | --- |
| Unipile API | Yes | Yes, real time | Medium | Built first, then dropped |
| Chrome extension reading our own inbox | Yes, via the Seen marker | Yes | Lower | **Chosen** |
| LinkedIn notification emails in Gmail | No | Mostly | None | Zero risk fallback |
| Outreach tools (HeyReach, Expandi) plus Zapier | Yes | Yes | Medium | Configuring, not building |
| Headless Playwright bot | Yes | Yes | High | Ban risk |

## The pivot

I first built the planned version on Unipile, a service that connects a
LinkedIn account and sends webhooks: a Node server, a SQLite event store, the
status engine, a Grok classifier and a Sheets adapter, with 98 tests (kept under
the `unipile-version` git tag). Two things changed my mind. The Unipile account
was suspended soon after first use, which is exactly the risk the brief warned
about. And setup needed about 11 keys, ngrok and an always-on server.

So I moved to the backup plan: a Chrome extension that reads the LinkedIn
Messages page the user already has open, and a Google Apps Script inside the
Sheet as the backend. No server, no service account, and setup is two values:
the script's web app URL and the AI key. The status engine carried over as is.

## Architecture

```
LinkedIn Messages page (open in Chrome)
   |  extension reads names, previews, the open thread and the Seen marker
   v
Chrome extension  --POST JSON-->  Google Apps Script web app (inside the Sheet)
                                    |- observe()    compares the screen with the row
                                    |- nextState()  pure status rules, unit tested
                                    |- CRM adapter  Leads, Events, Summary tabs
                                    |- classifier   Grok labels replies, drafts follow-ups
                                    '- timer        Follow-up due / Not replied
```

Choices worth calling out:

* **Compare, don't count.** The extension sends what it sees, not events. The
  script compares it with the row, and only a real difference becomes an event,
  so sending the same screen twice changes nothing.
* **One clock.** LinkedIn's "2:15 PM" labels are too rough to order messages,
  so every event uses the time the extension saw it.
* **Tracking starts at install.** Old chats become the starting point, not fake
  replies, so an old inbox never floods the Sheet.
* **The AI never blocks a status change.** The row moves to Replied first. If
  Grok fails, the category is Unclassified and everything carries on.
* **Humans send.** The extension never clicks, types or sends. Drafts go to the
  Suggested Follow-up column.

**Checked against the real page.** I first wrote the page selectors from
memory, then checked them on the live Messages page. Two guesses were wrong:
the conversation list has no links (so the extension learns each thread's id
when it is opened and remembers it by name), and a loosely matched "seen" class
also matched an element that is always on the page. Messages with a subject
line preview as the subject, so the open thread decides who sent them.

## Status rules

Status always reflects the latest turn, and never moves backwards unless we
send a new message.

| Trigger | Condition | New status |
| --- | --- | --- |
| Lead row added | none | Not contacted |
| New message from us | any | Message sent |
| Seen marker on our latest message | status is Message sent | Opened |
| New message from the lead | any | Replied, plus AI label |
| Timer, no reply after N days | Message sent or Opened | Follow-up due, or Not replied once follow-ups run out |

Defaults are 3 days and 2 follow-ups; demo mode reads days as minutes.
LinkedIn's web page has no delivered marker, so the brief's Delivered status
was dropped rather than kept as a step that never happens.

## Known limitations

* **It only syncs while LinkedIn Messages is open in Chrome.** Messages that
  arrive while it is closed are picked up later, timed when they were seen.
* **A conversation is tracked once it has been opened since install**, because
  only the open thread shows its id. Messaging a lead opens their thread, so
  this mostly affects old chats.
* **Opened needs the lead's read receipts on**, and the thread open while the
  Seen marker shows. Otherwise the lead stays at Message sent until they reply.
* **It depends on LinkedIn's page layout.** All selectors live in one file, and
  the popup's "Check this page" shows which still match.
* **Lower risk, not zero.** Reading your own screen is still scraping in the
  strict sense, though it makes no requests to LinkedIn.
* **The web app URL works like a password**, and Google Sheets is not a CRM at
  scale (Apps Script quotas).

## Path to HubSpot or Zoho

The rest of the script only talks to four methods: `listLeads`, `upsertLead`,
`updateStatus` and `logEvent`. For HubSpot, leads become contacts with a few
custom properties (tracker id, DM status, reply category, timestamps),
`logEvent` becomes a note on the contact, and calls go through `UrlFetchApp`
with a private app token. Zoho maps the same way onto its Leads module. The
README has the method by method mapping.

## Outcome

* A Chrome extension and an Apps Script that turn LinkedIn DM activity into
  live CRM status, with AI labels on replies and drafted follow-ups.
* 226 automated tests: status rules, matching, the Sheets adapter, the AI
  fallback, the web app, the extension's parser on LinkedIn-shaped HTML, and an
  end-to-end run from page to Sheet row.
* A live Sheet (Leads, Events, Summary) and a demo video of a row going from
  Message sent to Opened to Replied, and a quiet lead flipping to Follow-up due.
