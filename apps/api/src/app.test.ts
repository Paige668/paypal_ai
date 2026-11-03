import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type {
  MerchantOrder,
  OrderRepository,
  OrderTimeline,
  PayPalGateway,
  VerifiedWebhookEvent,
  WebhookIngestStatus
} from "./types.js";

class MemoryOrders implements OrderRepository {
  private readonly values = new Map<string, MerchantOrder>();
  private readonly providerEventIds = new Set<string>();
  async save(order: MerchantOrder) { this.values.set(order.merchantOrderId, structuredClone(order)); }
  async findByMerchantOrderId(id: string) { return structuredClone(this.values.get(id) ?? null); }
  async getTimeline(id: string): Promise<OrderTimeline | null> {
    const order = await this.findByMerchantOrderId(id);
    if (!order) return null;
    return {
      merchantOrderId: order.merchantOrderId,
      paypalOrderId: order.paypalOrderId,
      localStatus: order.localStatus,
      externalCaptureStatus: order.paypalCaptureStatus,
      events: order.evidence
    };
  }
  async recordVerifiedWebhook(event: VerifiedWebhookEvent): Promise<WebhookIngestStatus> {
    if (this.providerEventIds.has(event.providerEventId)) return "DUPLICATE";
    this.providerEventIds.add(event.providerEventId);
    const order = [...this.values.values()].find((candidate) =>
      candidate.paypalOrderId === event.paypalOrderId || candidate.paypalCaptureId === event.paypalCaptureId
    );
    if (!order) return "QUARANTINED";
    order.paypalCaptureId ??= event.paypalCaptureId;
    order.paypalCaptureStatus = event.captureStatus;
    order.evidence.push({
      evidenceId: `ev_webhook_${event.providerEventId}`,
      source: "PAYPAL_WEBHOOK",
      providerEventId: event.providerEventId,
      kind: event.eventType === "PAYMENT.CAPTURE.COMPLETED" ? "WEBHOOK_CAPTURE_COMPLETED" : "WEBHOOK_EVENT_OBSERVED",
      verificationStatus: "VERIFIED_WEBHOOK",
      observedAt: event.observedAt,
      providerCreatedAt: event.providerCreatedAt,
      summary: event.summary
    });
    return "PROCESSED";
  }
}

function setup(webhookConfigured = true) {
  const paypal: PayPalGateway = {
    createOrder: vi.fn().mockResolvedValue({ id: "PAYPAL-ORDER-1", status: "CREATED" }),
    captureOrder: vi.fn().mockResolvedValue({
      orderId: "PAYPAL-ORDER-1",
      orderStatus: "COMPLETED",
      captureId: "CAPTURE-1",
      captureStatus: "COMPLETED",
      currencyCode: "USD",
      value: "12.34"
    }),
    verifyWebhookSignature: vi.fn().mockResolvedValue(true)
  };
  const app = createApp({
    paypal,
    orders: new MemoryOrders(),
    paypalClientId: "public-sandbox-id",
    paypalWebhookId: webhookConfigured ? "WH-TEST-1" : undefined,
    webOrigin: "http://localhost:5173",
    now: () => new Date("2026-11-01T12:00:00.000Z")
  });
  return { app, paypal };
}

const webhookHeaders = {
  "paypal-transmission-id": "TRANSMISSION-1",
  "paypal-transmission-time": "2026-11-03T10:00:00Z",
  "paypal-cert-url": "https://api-m.sandbox.paypal.com/certs/test",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-transmission-sig": "test-signature"
};

function captureCompletedWebhook(paypalOrderId = "PAYPAL-ORDER-1") {
  return {
    id: "WH-EVENT-1",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    create_time: "2026-11-03T09:59:59Z",
    resource: {
      id: "CAPTURE-WEBHOOK-1",
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "12.34" },
      supplementary_data: { related_ids: { order_id: paypalOrderId } },
      payer: { email_address: "must-not-be-stored@example.com" }
    }
  };
}

describe("orders API", () => {
  it("creates, maps, captures, and returns allowlisted evidence", async () => {
    const { app, paypal } = setup();
    const created = await request(app).post("/api/orders").send({ currencyCode: "USD", value: "12.34" });
    expect(created.status).toBe(201);
    expect(created.body.paypalOrderId).toBe("PAYPAL-ORDER-1");
    expect(created.body.merchantOrderId).toMatch(/^ord_/);
    expect(created.body.localStatus).toBe("PENDING_PAYMENT");
    expect(created.body.evidence[0]).toMatchObject({ source: "PAYPAL_API", verificationStatus: "API_RESPONSE" });

    const captured = await request(app)
      .post(`/api/orders/${created.body.merchantOrderId}/capture`)
      .send({});
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({
      paypalCaptureId: "CAPTURE-1",
      paypalCaptureStatus: "COMPLETED",
      paypalOrderStatus: "COMPLETED",
      localStatus: "PAID"
    });
    expect(captured.body.evidence).toHaveLength(3);
    expect(paypal.captureOrder).toHaveBeenCalledWith("PAYPAL-ORDER-1", `capture-${created.body.merchantOrderId}`);

    const timeline = await request(app).get(`/api/orders/${created.body.merchantOrderId}/timeline`);
    expect(timeline.status).toBe(200);
    expect(timeline.body).toMatchObject({ localStatus: "PAID", externalCaptureStatus: "COMPLETED" });
    expect(timeline.body.events.map((event: { kind: string }) => event.kind)).toEqual([
      "ORDER_CREATED",
      "CAPTURE_COMPLETED",
      "MERCHANT_STATUS_UPDATED"
    ]);
  });

  it("returns an already recorded capture without calling PayPal twice", async () => {
    const { app, paypal } = setup();
    const created = await request(app).post("/api/orders").send({ currencyCode: "USD", value: "12.34" });
    await request(app).post(`/api/orders/${created.body.merchantOrderId}/capture`).send({});
    const repeated = await request(app).post(`/api/orders/${created.body.merchantOrderId}/capture`).send({});
    expect(repeated.status).toBe(200);
    expect(paypal.captureOrder).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid money input before contacting PayPal", async () => {
    const { app, paypal } = setup();
    const response = await request(app).post("/api/orders").send({ currencyCode: "usd", value: "1" });
    expect(response.status).toBe(400);
    expect(paypal.createOrder).not.toHaveBeenCalled();
  });

  it("processes a verified webhook once without conflating merchant status", async () => {
    const { app, paypal } = setup();
    const created = await request(app).post("/api/orders").send({ currencyCode: "USD", value: "12.34" });

    const first = await request(app)
      .post("/api/webhooks/paypal")
      .set(webhookHeaders)
      .send(captureCompletedWebhook());
    const duplicate = await request(app)
      .post("/api/webhooks/paypal")
      .set(webhookHeaders)
      .send(captureCompletedWebhook());
    const timeline = await request(app).get(`/api/orders/${created.body.merchantOrderId}/timeline`);

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ status: "PROCESSED" });
    expect(duplicate.body).toEqual({ status: "DUPLICATE" });
    expect(paypal.verifyWebhookSignature).toHaveBeenCalledTimes(2);
    expect(timeline.body).toMatchObject({
      externalCaptureStatus: "COMPLETED",
      localStatus: "PENDING_PAYMENT"
    });
    expect(timeline.body.events).toHaveLength(2);
    expect(timeline.body.events[1]).toMatchObject({
      source: "PAYPAL_WEBHOOK",
      providerEventId: "WH-EVENT-1",
      verificationStatus: "VERIFIED_WEBHOOK"
    });
    expect(JSON.stringify(timeline.body)).not.toContain("must-not-be-stored@example.com");
  });

  it("rejects an invalid webhook signature without recording evidence", async () => {
    const { app, paypal } = setup();
    vi.mocked(paypal.verifyWebhookSignature).mockResolvedValueOnce(false);
    const created = await request(app).post("/api/orders").send({ currencyCode: "USD", value: "12.34" });

    const response = await request(app)
      .post("/api/webhooks/paypal")
      .set(webhookHeaders)
      .send(captureCompletedWebhook());
    const timeline = await request(app).get(`/api/orders/${created.body.merchantOrderId}/timeline`);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "INVALID_WEBHOOK_SIGNATURE" });
    expect(timeline.body.externalCaptureStatus).toBeNull();
    expect(timeline.body.events).toHaveLength(1);
  });

  it("quarantines a verified event with no known order mapping", async () => {
    const { app } = setup();
    const response = await request(app)
      .post("/api/webhooks/paypal")
      .set(webhookHeaders)
      .send(captureCompletedWebhook("UNKNOWN-PAYPAL-ORDER"));

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: "QUARANTINED" });
  });

  it("keeps the webhook endpoint disabled until a registered webhook ID is configured", async () => {
    const { app, paypal } = setup(false);
    const response = await request(app)
      .post("/api/webhooks/paypal")
      .set("Content-Type", "application/json")
      .send(captureCompletedWebhook());

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "PAYPAL_WEBHOOK_NOT_CONFIGURED" });
    expect(paypal.verifyWebhookSignature).not.toHaveBeenCalled();
  });
});

