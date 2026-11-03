import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { MerchantOrder, OrderRepository, OrderTimeline, PayPalGateway } from "./types.js";

class MemoryOrders implements OrderRepository {
  private readonly values = new Map<string, MerchantOrder>();
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
}

function setup() {
  const paypal: PayPalGateway = {
    createOrder: vi.fn().mockResolvedValue({ id: "PAYPAL-ORDER-1", status: "CREATED" }),
    captureOrder: vi.fn().mockResolvedValue({
      orderId: "PAYPAL-ORDER-1",
      orderStatus: "COMPLETED",
      captureId: "CAPTURE-1",
      captureStatus: "COMPLETED",
      currencyCode: "USD",
      value: "12.34"
    })
  };
  const app = createApp({
    paypal,
    orders: new MemoryOrders(),
    paypalClientId: "public-sandbox-id",
    webOrigin: "http://localhost:5173",
    now: () => new Date("2026-11-01T12:00:00.000Z")
  });
  return { app, paypal };
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
});

