import { useEffect, useRef, useState } from "react";

type Order = {
  merchantOrderId: string;
  paypalOrderId: string;
  paypalCaptureId: string | null;
  paypalOrderStatus: string;
  paypalCaptureStatus: string | null;
  amount: { currencyCode: string; value: string };
  captureObservedAt: string | null;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Request failed");
  return body as T;
}

function loadPayPalSdk(clientId: string, currency: string): Promise<void> {
  if (window.paypal) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>("script[data-paypal-sdk]");
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("PayPal SDK failed to load")), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.dataset.paypalSdk = "true";
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${encodeURIComponent(currency)}&intent=capture`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("PayPal SDK failed to load"));
    document.head.appendChild(script);
  });
}

export function App() {
  const [amount, setAmount] = useState("10.00");
  const [order, setOrder] = useState<Order | null>(null);
  const [status, setStatus] = useState("Loading PayPal Sandbox…");
  const [error, setError] = useState<string | null>(null);
  const amountRef = useRef(amount);
  const orderRef = useRef<Order | null>(null);
  amountRef.current = amount;

  useEffect(() => {
    let cancelled = false;
    let buttons: { render(selector: string): Promise<void>; close(): Promise<void> } | undefined;
    api<{ clientId: string; currency: string }>("/api/config/paypal")
      .then(async (config) => {
        await loadPayPalSdk(config.clientId, config.currency);
        if (cancelled || !window.paypal) return;
        buttons = window.paypal.Buttons({
          createOrder: async () => {
            setError(null);
            setStatus("Creating a real PayPal Sandbox order…");
            const created = await api<Order>("/api/orders", {
              method: "POST",
              body: JSON.stringify({ currencyCode: "USD", value: amountRef.current })
            });
            orderRef.current = created;
            setOrder(created);
            setStatus("Waiting for Sandbox buyer approval…");
            return created.paypalOrderId;
          },
          onApprove: async (data) => {
            setStatus("Capturing on the server…");
            const current = orderRef.current;
            if (!current || current.paypalOrderId !== data.orderID) {
              throw new Error("Approved PayPal order did not match the local merchant order.");
            }
            const captured = await api<Order>(`/api/orders/${encodeURIComponent(current.merchantOrderId)}/capture`, {
              method: "POST",
              body: "{}"
            });
            orderRef.current = captured;
            setOrder(captured);
            setStatus(captured.paypalCaptureStatus === "COMPLETED" ? "Sandbox capture completed." : "Capture response recorded.");
          },
          onCancel: () => setStatus("Buyer cancelled the Sandbox checkout."),
          onError: (cause) => {
            console.error(cause);
            setError("PayPal Sandbox checkout failed. Check the API log and Sandbox account configuration.");
          }
        });
        await buttons.render("#paypal-buttons");
        if (!cancelled) setStatus("Ready for a Sandbox checkout.");
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to initialize checkout");
      });
    return () => {
      cancelled = true;
      void buttons?.close();
    };
  }, []);

  return (
    <main>
      <p className="eyebrow">PayTrace AI · November 1 milestone</p>
      <h1>Prove the payment before investigating it.</h1>
      <p className="lede">
        Create, approve, and capture one real PayPal Sandbox order. Only allowlisted provider evidence is stored.
      </p>
      <section className="checkout">
        <label>
          Sandbox amount (USD)
          <input value={amount} onChange={(event) => setAmount(event.target.value)} pattern="\d+\.\d{2}" />
        </label>
        <div id="paypal-buttons" />
        <p className="status" aria-live="polite">{status}</p>
        {error && <p className="error" role="alert">{error}</p>}
      </section>
      {order && (
        <section className="evidence">
          <div className="badge">REAL · PayPal Sandbox API</div>
          <h2>Allowlisted payment evidence</h2>
          <dl>
            <dt>Merchant order</dt><dd>{order.merchantOrderId}</dd>
            <dt>PayPal order</dt><dd>{order.paypalOrderId}</dd>
            <dt>Order status</dt><dd>{order.paypalOrderStatus}</dd>
            <dt>Capture ID</dt><dd>{order.paypalCaptureId ?? "Awaiting approval"}</dd>
            <dt>Capture status</dt><dd>{order.paypalCaptureStatus ?? "Not captured"}</dd>
            <dt>Amount</dt><dd>{order.amount.value} {order.amount.currencyCode}</dd>
            <dt>Observed</dt><dd>{order.captureObservedAt ?? "—"}</dd>
          </dl>
        </section>
      )}
      <footer>Sandbox only · No refunds · No automatic financial remediation</footer>
    </main>
  );
}

