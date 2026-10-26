# Pivot Plan: Chrome Extension + Apps Script

Oct 26, 2026 · @Raghav Gangwar

## Why we pivoted

We dropped Unipile because the account was suspended soon after first use, and the setup needed about 11 keys and environment variables.

This is useful material for the process doc: "tried Unipile, account got flagged, pivoted to a lower-risk design." A real pivot shows judgment. Before continuing, confirm the personal LinkedIn account itself is still in good standing.

## How the new design works

A Chrome extension reads LinkedIn Messages from the user's own screen and sends it to a Google Apps Script attached to the Sheet. There is no server, no ngrok, no deployment and no service account.

1. The user opens LinkedIn Messages in Chrome as normal.
2. The extension reads what is already on screen: each conversation's name, profile link, last message, whether the last message is from the user or the lead, and the Seen marker when a thread is open.
3. It posts that data to a Google Apps Script web app. Apps Script is free JavaScript hosted by Google and replaces the whole Node backend.
4. Apps Script updates the lead's row: Message sent, Opened, or Replied.
5. A daily Apps Script timer marks leads as Not replied or Follow-up due.
6. On a new reply, Apps Script calls Grok to label it (Interested, Not interested, and so on).

**Total setup:** the Apps Script URL pasted into the extension, and the Grok key stored in Script Properties.

## Unipile version vs new version

The new version cuts setup from about 11 keys to 2 and removes the server entirely.

|  | Unipile version | New version |
| --- | --- | --- |
| Keys and env vars | About 11 | 2 (Apps Script URL, Grok key) |
| Server to run | Yes | No |
| Account risk | Got suspended | Lower: reads own screen only, never auto-sends |
| Cost | Trial, then paid | Free |
| Reviewer setup | Complex | Load extension, paste URL, done |

## Trade-offs to state in the process doc

The design is simpler and safer, but it only works while LinkedIn is open in the browser.

- **Not 24/7:** it syncs only while LinkedIn is open in Chrome.
- **Layout dependent:** if LinkedIn changes its page structure, the selectors need updating.
- **Opened is partial:** it is captured when a thread is opened and the Seen marker is present, and it still depends on the lead having read receipts on.
- **Lower risk, not zero:** it is still a scraper in the strict sense. Saying so honestly helps.

## Timeline

Three days to submission on Oct 28, 2026; tight but doable since the build is much smaller.

- [ ] **Mon:** extension that reads the conversation list and an open thread, plus the Apps Script endpoint that writes rows. Have Claude Code inspect LinkedIn's actual page structure first rather than guessing selectors.
- [ ] **Tue:** status rules, the daily timer, Grok labelling, then record the demo.
- [ ] **Wed morning:** README and process doc, then submit.
