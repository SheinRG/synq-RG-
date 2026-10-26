# Demo runbook

The video matters most. Aim for 3 to 5 minutes, Sheet and LinkedIn side by side.

## Before recording

1. `npm test` is green.
2. The Sheet is set up (**Lead Tracker > Set up sheet**), the AI key is set,
   and the web app is deployed.
3. Click **Lead Tracker > Demo mode on**. In Script Properties, set
   `NOT_REPLIED_AFTER_DAYS` to `2` (2 minutes in demo mode).
4. The extension is loaded, the URL is saved, and **Test connection** shows the
   Sheet's name.
5. Put 2 or 3 friends in the Leads tab (name, company, LinkedIn URL only). They
   get Lead IDs and `Not contacted` within a few seconds, or on the next sync.
6. Open https://www.linkedin.com/messaging/ once before recording, so the
   extension records its starting point.
7. Ask friend A to keep read receipts on and be ready to open your message and
   reply. Friend B should not reply.

## Script

| Time | Show | Say |
| --- | --- | --- |
| 0:00 | The Sheet | The problem: DM status never reaches the CRM. The Sheet is our CRM. |
| 0:30 | Architecture diagram from the README | Extension reads my own Messages page, Apps Script runs the rules, Grok labels replies. Why not the official API, and why I moved off Unipile. |
| 1:00 | LinkedIn, send a DM to friend A | Row A flips to Message sent within a few seconds. |
| 1:30 | Friend A opens it; keep the thread open | The Seen marker appears and row A flips to Opened, Opened At fills in. |
| 2:00 | Friend A replies "Sounds good, can we talk Monday?" | Row A flips to Replied; Reply Category says Interested with a summary and a suggested reply. |
| 2:45 | DM friend B, who does not reply | Row B goes to Message sent. |
| 3:15 | Wait for the minute tick (or **Run follow-up check now**) | Row B flips to Follow-up due with a drafted follow-up. Nothing was sent. |
| 3:45 | Events and Summary tabs | Every transition is logged; open and reply rates update from formulas. |
| 4:15 | `createSheetCrm` in `Code.js`, `npm test`, the extension popup | Four methods to plug in HubSpot; tests; limitations in one breath. |

## If something goes wrong

* Nothing happens on send: open the extension popup. The last sync shows the
  error, if any. **Sync now** forces a full send of what is on screen.
* The row never matches: check the LinkedIn URL in the row looks like
  `linkedin.com/in/<name>`, or open the thread once so the extension can read
  the profile link.
* Counts in **Check this page** are zero: LinkedIn changed its markup; fix the
  selector in `extension/selectors.js` and reload the extension.
* Opened never shows: the friend has read receipts off, or the thread was not
  open when the Seen marker appeared. Open the thread.
* Category says Unclassified: check the key with **Lead Tracker > Set AI key**
  and look at **Executions** in the Apps Script editor for the error.
* After editing `Code.js`, redeploy: **Deploy > Manage deployments > Edit >
  New version**. The URL stays the same.
