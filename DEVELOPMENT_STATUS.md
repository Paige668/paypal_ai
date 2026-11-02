# PayTrace development status

**Status date:** 2026-11-02 (Europe/Stockholm)  
**Requested execution boundary:** development plan through 2026-11-01

## Evidence-based status

| Plan date | Scope | Status | Evidence |
| --- | --- | --- | --- |
| 2026-10-30 | React/Express TypeScript scaffold, environment template, start/build/test/lint commands | TESTED | `npm run build`, `npm run lint`, API tests |
| 2026-10-31 | Server OAuth, PayPal Orders v2 Create, internal ↔ external ID record, controlled errors | TESTED WITH MOCKED PROVIDER; REAL SANDBOX PENDING | API implementation and automated mapping/input tests |
| 2026-11-01 | PayPal JS approval, server Capture, capture ID/status/amount evidence persistence | TESTED WITH MOCKED PROVIDER; REAL SANDBOX PENDING | UI build, capture/idempotency tests, persistent repository test |

## Manual external verification still required

The following cannot be truthfully marked `VERIFIED` without the project owner's PayPal Sandbox app and buyer account:

1. OAuth succeeds against `api-m.sandbox.paypal.com` with the user's app credentials.
2. The PayPal JavaScript SDK completes buyer approval for the same REST app.
3. The server Capture response is genuinely `COMPLETED` and supplies a real Sandbox capture ID.
4. The persisted record survives an API restart and matches the allowlisted provider response.

Follow the **November 1 acceptance check** in `README.md`. Do not put credentials or captured buyer information into chat, source files, logs, screenshots, or git.

## Not started by design

SQLite/event timeline (11/02), verified Webhook ingestion (11/03), merchant fault injection/reconciliation (11/05), evidence-grounded AI (11/06), investigation UI (11/07), final integration/submission work (11/08 onward).
