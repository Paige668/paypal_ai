# PayTrace AI

PayTrace is a developer-first PayPal Sandbox incident investigation lab. This repository currently implements the local development plan through **2026-11-06**: a React/Express TypeScript application, server-side PayPal OAuth, Orders v2 creation and capture, a transactional SQLite evidence timeline, a signature-gated PayPal Webhook inbox, deterministic merchant-side fault reconciliation, and evidence-grounded read-only AI investigation.

This is not a production payment system. It uses Sandbox only. The Webhook listener and official PayPal postback verification flow are implemented, covered by automated tests, and verified with a genuine app-linked Sandbox Webhook delivery. Merchant-fault replay and reconciliation are implemented as local-only demo controls. AI explains an existing deterministic Incident; it does not determine payment truth or receive mutation tools.

## Current trust boundary

- PayPal Client Secret stays in the API process.
- The browser receives only the public Sandbox Client ID.
- The API stores only allowlisted order/capture fields in `data/paytrace.sqlite`; it does not store buyer data or raw PayPal payloads.
- A capture can only be requested for a PayPal order already mapped to the internal merchant order.
- `PayPal-Request-Id` is stable per merchant order for create and capture attempts.
- PayPal external status and merchant-local status are separate fields supported by events with explicit provenance and verification status.
- Webhook payloads cannot change payment state unless PayPal's official verification endpoint returns `SUCCESS`.
- The Webhook inbox stores only allowlisted fields, deduplicates non-null provider event IDs, and quarantines unknown order mappings.

## API structure

The API uses a small layered structure rather than a framework-specific MVC implementation:

- `app.ts` composes dependencies, middleware, routes, and shared error handling.
- `routes/` translates HTTP requests and responses without owning payment rules.
- `services/` coordinates order and Webhook workflows against interfaces.
- `paypal.ts` is the PayPal API adapter.
- `order-store.ts` is the transactional SQLite repository.
- `types.ts` defines the contracts between layers.

Routes depend on services, services depend on gateway/repository interfaces, and infrastructure implementations remain replaceable in tests.

## Run locally

Requirements: Node.js 20+ and a PayPal Developer Sandbox app with a Sandbox business account and buyer account.

```bash
cp .env.example .env
# Fill PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET from the same Sandbox REST app.
npm install
npm run dev
```

Open `http://localhost:5173`. Enter a Sandbox amount, choose **Pay with PayPal Sandbox**, and sign in with the Sandbox buyer account. A successful flow shows the internal merchant order ID, PayPal order ID, capture ID, status, amount/currency, and observation time.

The API listens on `http://localhost:3001` by default. Vite proxies `/api` during development.

On first start with an empty SQLite database, the API imports an existing allowlisted `data/orders.json` store if present. The legacy file remains local and ignored by git.

## Commands

```bash
npm run dev
npm run build
npm test
npm run lint
```

## Verified milestones

1. `npm test` and `npm run build` pass.
2. No `.env` file or secret is committed.
3. `POST /api/orders` creates a genuine Sandbox order and returns an internal ↔ PayPal order mapping.
4. Buyer approval happens in PayPal's Sandbox UI.
5. `POST /api/orders/:merchantOrderId/capture` returns `COMPLETED` and the UI displays the real Sandbox capture ID.
6. Restart the API and `GET /api/orders/:merchantOrderId` still returns the allowlisted record from `data/paytrace.sqlite`.

The project owner completed steps 3–6 with a real Sandbox personal buyer on 2026-11-02. Automated tests continue to use a mocked provider and temporary local databases; credentials are never used in the test suite.

## State, timeline, and Incident persistence

- `merchant_orders` stores PayPal external status independently from merchant-local status.
- `payment_events` records ordered, allowlisted evidence with source and verification status.
- A partial unique index enforces deduplication for non-null PayPal provider event IDs received through the verified Webhook inbox.
- `scenario_runs`, `incidents`, and `ai_reports` persist the merchant-only reproduction, deterministic mismatch finding, and evidence-grounded investigation separately from payment evidence.
- A normal completed capture records external `COMPLETED` and a separate merchant transition to `PAID`.

## November 3 Webhook inbox

- `POST /api/webhooks/paypal` captures the raw JSON body before the normal JSON parser.
- Required PayPal transmission headers and the registered `PAYPAL_WEBHOOK_ID` are sent to `/v1/notifications/verify-webhook-signature`.
- Invalid signatures are rejected before persistence or state changes.
- Verified events are inserted transactionally and acknowledged as `PROCESSED`, `DUPLICATE`, or `QUARANTINED`.
- `PAYMENT.CAPTURE.COMPLETED` updates external capture evidence without deriving merchant-local status from the Webhook payload.
- Raw payloads and buyer data are not stored.

## November 5 merchant-fault reconciliation

- Demo controls are denied by default and require `DEMO_MODE=true`.
- `MERCHANT_UPDATE_FAILURE` deliberately keeps the merchant-local order at `PENDING_PAYMENT` while preserving the real Sandbox Capture evidence as `COMPLETED`.
- `PAYMENT_CAPTURED_MERCHANT_PENDING` is opened only after the configurable application grace period; the grace period is not represented as a PayPal SLA.
- Repeated reconciliation within one scenario returns the same Incident instead of duplicating it.
- Replay creates a distinct `scenarioRunId`, references the preceding run, and performs no PayPal Create, Capture, Refund, or Webhook-redelivery call.
- Reset resolves the local demo run and restores only the merchant-local status; immutable Capture evidence remains unchanged.

The workflow was manually smoke-tested against retained evidence from a genuine completed Sandbox Capture. Injection produced the expected local mismatch, immediate reconciliation respected the test grace period, later reconciliation opened one evidence-linked Incident, Replay created a distinct run without adding PayPal API evidence, and Reset restored `PAID` while preserving the original Capture ID and `COMPLETED` status. No new PayPal order or Capture was triggered during this verification.

To enable the local demo explicitly:

```bash
DEMO_MODE=true
RECONCILIATION_GRACE_MS=60000
```

The demo API flow is: create a scenario run for a merchant order, perform or reuse its completed Sandbox Capture, reconcile after the grace period, optionally replay, then reset.

## November 6 evidence-grounded investigation

- A minimized evidence pack contains the deterministic rule, incident state, provenance, verification status, timestamps, sanitized values, and resolvable evidence IDs. PayPal order/capture identifiers, secrets, raw payloads, and buyer data are excluded.
- The OpenAI Responses API requests a strict JSON Schema through `text.format`, following the [official Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs).
- Zod validates the returned structure, then a separate citation checker rejects every unknown evidence ID.
- Unsafe next steps that attempt a payment, Capture, refund, or automatic status mutation are rejected.
- Valid reports are persisted in SQLite as `AI_GENERATED`; model failures, invalid output, and missing configuration persist an honest `FALLBACK` report without hiding the deterministic Incident.
- Historical reports distinguish the merchant state at detection time from the current state after Reset.

The complete path was live-verified on 2026-11-06 with a server-side OpenAI project key and `gpt-5-mini`: the Responses API returned an `AI_GENERATED` report, every cited evidence ID resolved to the minimized pack, the report was read back unchanged from SQLite, and the merchant order remained `COMPLETED | PAID` with demo fault injection disabled. The initial 15-second timeout proved too short for the first strict-schema request, so the bounded server timeout is 60 seconds.

Configure the server-side model connection when available:

```bash
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5-mini
OPENAI_API_BASE_URL=https://api.openai.com
OPENAI_TIMEOUT_MS=60000
```

The API key stays in the backend process and is never included in the browser configuration or evidence pack. Without a key, `POST /api/investigations/scenarios/:scenarioRunId` returns `failureCode: AI_NOT_CONFIGURED` with a cited rule-based fallback.

### Release-blocking OpenAI model check

Before final acceptance or recording the submission demo:

- Change the project's default model from the currently verified `gpt-5-mini` to `gpt-6.1-terra` while retaining `OPENAI_MODEL` as an environment-variable override.
- Run one genuine end-to-end OpenAI check covering incident creation, evidence-grounded investigation, citation validation, SQLite report read-back, and confirmation that no payment or merchant-state mutation occurred.
- Run the full automated test, lint, and production-build checks, then record the selected model and verification result in `DEVELOPMENT_STATUS.md`.

This is a release-blocking checklist item, not a requirement for day-to-day development. Do not record the final demo or mark the project submission-ready until it is complete.

## November 7 single-purpose investigation UI

The React application now presents the complete workflow on one responsive screen:

1. Complete a genuine PayPal Sandbox checkout and confirm the normal `COMPLETED | PAID` path.
2. Start the explicitly labeled simulated merchant-update failure; provider evidence remains unchanged.
3. Run deterministic reconciliation after the displayed application grace period.
4. Inspect the Incident and its linked Capture and merchant-fault evidence IDs.
5. Generate the persisted evidence-grounded AI report, or the honest rule-based fallback when AI is unavailable.
6. Replay the merchant-only scenario with a new scenario ID or reset merchant state without making another PayPal call.

The UI visually distinguishes `Sandbox PayPal API`, `Verified PayPal Webhook`, `Merchant`, and `Simulated merchant fault` provenance. Report citations navigate to the referenced timeline event, while facts, hypotheses, unknowns, and safe next steps remain separate. Empty, loading, disabled-demo, grace-period, fallback, and request-error states are represented without hiding the deterministic evidence.

Implementation verification includes 24 API tests, 3 focused web presentation tests, TypeScript lint checks, and a production build. Final browser walkthrough with the project owner's Sandbox buyer remains a manual acceptance item and must not be marked complete from automated checks alone.

A genuine `PAYMENT.CAPTURE.COMPLETED` delivery from the same Sandbox REST app was verified on 2026-11-04 through a temporary public HTTPS tunnel. The event passed PayPal's official postback signature verification, was recorded once with `PAYPAL_WEBHOOK` provenance and `VERIFIED_WEBHOOK` status, remained deduplicated after redelivery, and persisted across an API restart. The temporary tunnel was stopped after validation. PayPal Webhooks Simulator events do not support postback verification and do not count as app-linked Sandbox evidence.

## API surface implemented so far

- `GET /api/health`
- `GET /api/config/paypal`
- `POST /api/orders`
- `GET /api/orders/:merchantOrderId`
- `GET /api/orders/:merchantOrderId/timeline`
- `POST /api/orders/:merchantOrderId/capture`
- `POST /api/webhooks/paypal`
- `POST /api/demo/scenario-runs`
- `GET /api/demo/scenario-runs/:scenarioRunId`
- `POST /api/demo/scenario-runs/:scenarioRunId/reconcile`
- `POST /api/demo/scenario-runs/:scenarioRunId/replay`
- `POST /api/demo/orders/:merchantOrderId/reset`
- `POST /api/investigations/scenarios/:scenarioRunId`
- `GET /api/investigations/scenarios/:scenarioRunId`

## License

MIT. See [LICENSE](./LICENSE).

