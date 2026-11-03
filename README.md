# PayTrace AI

PayTrace is a developer-first PayPal Sandbox incident investigation lab. This repository currently implements the development plan through **2026-11-02**: a minimal React/Express TypeScript application, server-side PayPal OAuth, Orders v2 creation, buyer approval with the PayPal JavaScript SDK, server-side capture, and a transactional SQLite order and evidence timeline.

This is not a production payment system. It uses Sandbox only. Webhooks, reconciliation, AI investigation, and merchant-fault replay belong to later milestones and are not claimed as implemented yet.

## Current trust boundary

- PayPal Client Secret stays in the API process.
- The browser receives only the public Sandbox Client ID.
- The API stores only allowlisted order/capture fields in `data/paytrace.sqlite`; it does not store buyer data or raw PayPal payloads.
- A capture can only be requested for a PayPal order already mapped to the internal merchant order.
- `PayPal-Request-Id` is stable per merchant order for create and capture attempts.
- PayPal external status and merchant-local status are separate fields supported by events with explicit provenance and verification status.

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
6. Restart the API and `GET /api/orders/:merchantOrderId` still returns the allowlisted record from `data/orders.json`.

The project owner completed steps 3–6 with a real Sandbox personal buyer on 2026-11-02. Automated tests continue to use a mocked provider and temporary local databases; credentials are never used in the test suite.

## November 2 state and timeline

- `merchant_orders` stores PayPal external status independently from merchant-local status.
- `payment_events` records ordered, allowlisted evidence with source and verification status.
- A partial unique index reserves non-null PayPal provider event IDs for later webhook deduplication.
- `incidents` is created as an empty schema for the later deterministic reconciliation milestone.
- A normal completed capture records external `COMPLETED` and a separate merchant transition to `PAID`.

## API surface implemented so far

- `GET /api/health`
- `GET /api/config/paypal`
- `POST /api/orders`
- `GET /api/orders/:merchantOrderId`
- `GET /api/orders/:merchantOrderId/timeline`
- `POST /api/orders/:merchantOrderId/capture`

## License

MIT. See [LICENSE](./LICENSE).

