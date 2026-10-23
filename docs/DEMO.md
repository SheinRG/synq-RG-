# Demo runbook

The video matters most. Aim for 3 to 5 minutes, Sheet and LinkedIn side by side.

## Before recording

1. `.env` filled in, with `DEMO_MODE=true` and `NOT_REPLIED_AFTER_DAYS=2`
   (2 minutes in demo mode).
2. `npm test` is green.
3. `npm run check-llm` labels the sample reply.
4. `npm run setup-sheet` has been run, and the sheet has 2 or 3 friends in the
   Leads tab (name, company, LinkedIn URL only).
5. `npm run dev` is running, ngrok is running, `npm run register-webhook` done.
6. Within a minute the rows get Lead IDs, `Not contacted`, and a Provider ID.
7. Ask friend A to keep LinkedIn open and read receipts on. Friend B should
   not reply.

## Script

| Time | Show | Say |
| --- | --- | --- |
| 0:00 | The sheet | The problem: DM status never reaches the CRM. The sheet is our CRM. |
| 0:30 | Architecture diagram from the README | Unipile webhooks, status engine, Grok, sheet adapter. Why not the official API. |
| 1:00 | LinkedIn, send a DM to friend A | Row A flips to Message sent, then Delivered. |
| 1:30 | Friend A opens it | Row A flips to Opened, Opened At fills in. |
| 2:00 | Friend A replies "Sounds good, can we talk Monday?" | Row A flips to Replied; Reply Category says Interested with a summary and a suggested reply. |
| 2:45 | DM friend B, who does not reply | Row B goes to Message sent. |
| 3:15 | Wait for the minute tick (or `POST /admin/follow-up-check`) | Row B flips to Follow-up due with a drafted follow-up. Nothing was sent. |
| 3:45 | Events and Summary tabs | Every transition is logged; open and reply rates update from formulas. |
| 4:15 | `src/crm/adapter.ts` and `npm test` | Four methods to plug in HubSpot; 98 tests. Limitations in one breath. |

## Trigger the follow-up check on demand

```bash
curl -X POST http://localhost:3000/admin/follow-up-check -H "x-admin-secret: $WEBHOOK_SECRET"
```

## If something goes wrong

* Nothing happens on send: check the server log. `[webhook] ... ignored` lines
  say why. Run `npm run register-webhook -- --list` to confirm the URL.
* Rows never get a Provider ID: the LinkedIn URL must look like
  `linkedin.com/in/<name>`.
* 401 in the ngrok inspector: `WEBHOOK_SECRET` changed after registering; register again.
* Category says Unclassified: check `npm run check-llm`.
