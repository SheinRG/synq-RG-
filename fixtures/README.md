# Fixtures

`docs-example/` holds payloads built from the example in the Unipile docs
(https://developer.unipile.com/docs/new-messages-webhook). The docs show one
example (`message_received`) and say read and delivered events share its shape,
so the read and delivered files reuse that shape. They drive the tests.

Real payloads go in `real/`. Capture them with `npm run log-webhooks` (which
writes to `fixtures/raw/`, ignored by git), replace names, ids and message text
with fake values, then copy them here. Real captures beat the docs: if a field
differs, trust the capture and update `src/webhooks/unipile.ts`.
