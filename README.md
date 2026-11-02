# PayTrace AI

PayTrace is a developer-first PayPal Sandbox incident investigation lab. This repository currently implements the development plan through **2026-11-01**: a minimal React/Express TypeScript application, server-side PayPal OAuth, Orders v2 creation, buyer approval with the PayPal JavaScript SDK, server-side capture, and a persisted allowlisted evidence record.

This is not a production payment system. It uses Sandbox only. Webhooks, reconciliation, AI investigation, and merchant-fault replay belong to later milestones and are not claimed as implemented yet.

## Current trust boundary

- PayPal Client Secret stays in the API process.
- The browser receives only the public Sandbox Client ID.
- The API stores only allowlisted order/capture fields in `data/orders.json`; it does not store buyer data or raw PayPal payloads.
- A capture can only be requested for a PayPal order already mapped to the internal merchant order.
- `PayPal-Request-Id` is stable per merchant order for create and capture attempts.

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

## Commands

```bash
npm run dev
npm run build
npm test
npm run lint
```

## November 1 acceptance check

1. `npm test` and `npm run build` pass.
2. No `.env` file or secret is committed.
3. `POST /api/orders` creates a genuine Sandbox order and returns an internal ↔ PayPal order mapping.
4. Buyer approval happens in PayPal's Sandbox UI.
5. `POST /api/orders/:merchantOrderId/capture` returns `COMPLETED` and the UI displays the real Sandbox capture ID.
6. Restart the API and `GET /api/orders/:merchantOrderId` still returns the allowlisted record from `data/orders.json`.

Steps 3–6 require user-owned Sandbox credentials and cannot be truthfully marked verified from automated mocks alone.

## API surface implemented so far

- `GET /api/health`
- `GET /api/config/paypal`
- `POST /api/orders`
- `GET /api/orders/:merchantOrderId`
- `POST /api/orders/:merchantOrderId/capture`

## License

MIT. See [LICENSE](./LICENSE).

