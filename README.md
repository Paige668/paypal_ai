# PayTrace AI

PayTrace is a developer-first PayPal Sandbox incident investigation lab. This repository currently implements the local development plan through **2026-11-03**: a React/Express TypeScript application, server-side PayPal OAuth, Orders v2 creation and capture, a transactional SQLite evidence timeline, and a signature-gated PayPal Webhook inbox.

This is not a production payment system. It uses Sandbox only. The Webhook listener and official PayPal postback verification flow are implemented, covered by automated tests, and verified with a genuine app-linked Sandbox Webhook delivery. Reconciliation, AI investigation, and merchant-fault replay belong to later milestones.

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

## November 2 state and timeline

- `merchant_orders` stores PayPal external status independently from merchant-local status.
- `payment_events` records ordered, allowlisted evidence with source and verification status.
- A partial unique index reserves non-null PayPal provider event IDs for later webhook deduplication.
- `incidents` is created as an empty schema for the later deterministic reconciliation milestone.
- A normal completed capture records external `COMPLETED` and a separate merchant transition to `PAID`.

## November 3 Webhook inbox

- `POST /api/webhooks/paypal` captures the raw JSON body before the normal JSON parser.
- Required PayPal transmission headers and the registered `PAYPAL_WEBHOOK_ID` are sent to `/v1/notifications/verify-webhook-signature`.
- Invalid signatures are rejected before persistence or state changes.
- Verified events are inserted transactionally and acknowledged as `PROCESSED`, `DUPLICATE`, or `QUARANTINED`.
- `PAYMENT.CAPTURE.COMPLETED` updates external capture evidence without deriving merchant-local status from the Webhook payload.
- Raw payloads and buyer data are not stored.

A genuine `PAYMENT.CAPTURE.COMPLETED` delivery from the same Sandbox REST app was verified on 2026-11-04 through a temporary public HTTPS tunnel. The event passed PayPal's official postback signature verification, was recorded once with `PAYPAL_WEBHOOK` provenance and `VERIFIED_WEBHOOK` status, remained deduplicated after redelivery, and persisted across an API restart. The temporary tunnel was stopped after validation. PayPal Webhooks Simulator events do not support postback verification and do not count as app-linked Sandbox evidence.

## API surface implemented so far

- `GET /api/health`
- `GET /api/config/paypal`
- `POST /api/orders`
- `GET /api/orders/:merchantOrderId`
- `GET /api/orders/:merchantOrderId/timeline`
- `POST /api/orders/:merchantOrderId/capture`
- `POST /api/webhooks/paypal`

## License

MIT. See [LICENSE](./LICENSE).

