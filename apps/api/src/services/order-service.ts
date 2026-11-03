import { randomUUID } from "node:crypto";
import type { MerchantOrder, OrderRepository, OrderTimeline, PayPalGateway } from "../types.js";

export class OrderServiceError extends Error {
  constructor(readonly code: "ORDER_NOT_FOUND" | "PAYPAL_ORDER_MAPPING_MISMATCH", readonly status: number) {
    super(code);
    this.name = "OrderServiceError";
  }
}

export class OrderService {
  constructor(
    private readonly paypal: PayPalGateway,
    private readonly orders: OrderRepository,
    private readonly now: () => Date
  ) {}

  async create(input: { currencyCode: string; value: string }): Promise<MerchantOrder> {
    const merchantOrderId = `ord_${randomUUID()}`;
    const paypalOrder = await this.paypal.createOrder({
      merchantOrderId,
      currencyCode: input.currencyCode,
      value: input.value,
      requestId: `create-${merchantOrderId}`
    });
    const observedAt = this.now().toISOString();
    const order: MerchantOrder = {
      merchantOrderId,
      paypalOrderId: paypalOrder.id,
      paypalCaptureId: null,
      paypalOrderStatus: paypalOrder.status === "CREATED" ? "CREATED" : "APPROVED",
      paypalCaptureStatus: null,
      localStatus: "PENDING_PAYMENT",
      amount: input,
      createdAt: observedAt,
      updatedAt: observedAt,
      captureObservedAt: null,
      evidence: [{
        evidenceId: `ev_${randomUUID()}`,
        source: "PAYPAL_API",
        providerEventId: null,
        kind: "ORDER_CREATED",
        verificationStatus: "API_RESPONSE",
        observedAt,
        providerCreatedAt: null,
        summary: { paypalOrderId: paypalOrder.id, status: paypalOrder.status }
      }]
    };
    await this.orders.save(order);
    return order;
  }

  async get(merchantOrderId: string): Promise<MerchantOrder> {
    const order = await this.orders.findByMerchantOrderId(merchantOrderId);
    if (!order) throw new OrderServiceError("ORDER_NOT_FOUND", 404);
    return order;
  }

  async getTimeline(merchantOrderId: string): Promise<OrderTimeline> {
    const timeline = await this.orders.getTimeline(merchantOrderId);
    if (!timeline) throw new OrderServiceError("ORDER_NOT_FOUND", 404);
    return timeline;
  }

  async capture(merchantOrderId: string): Promise<MerchantOrder> {
    const order = await this.get(merchantOrderId);
    if (order.paypalCaptureId) return order;

    const result = await this.paypal.captureOrder(order.paypalOrderId, `capture-${order.merchantOrderId}`);
    if (result.orderId !== order.paypalOrderId) {
      throw new OrderServiceError("PAYPAL_ORDER_MAPPING_MISMATCH", 409);
    }
    const observedAt = this.now().toISOString();
    const updated: MerchantOrder = {
      ...order,
      paypalCaptureId: result.captureId,
      paypalOrderStatus: result.orderStatus === "COMPLETED" ? "COMPLETED" : "APPROVED",
      paypalCaptureStatus: result.captureStatus,
      localStatus: result.captureStatus === "COMPLETED" ? "PAID" : order.localStatus,
      amount: { currencyCode: result.currencyCode, value: result.value },
      updatedAt: observedAt,
      captureObservedAt: observedAt,
      evidence: [
        ...order.evidence,
        {
          evidenceId: `ev_${randomUUID()}`,
          source: "PAYPAL_API",
          providerEventId: null,
          kind: result.captureStatus === "COMPLETED" ? "CAPTURE_COMPLETED" : "CAPTURE_OBSERVED",
          verificationStatus: "API_RESPONSE",
          observedAt,
          providerCreatedAt: null,
          summary: {
            paypalOrderId: result.orderId,
            captureId: result.captureId,
            status: result.captureStatus,
            currencyCode: result.currencyCode,
            value: result.value
          }
        },
        ...(result.captureStatus === "COMPLETED" ? [{
          evidenceId: `ev_${randomUUID()}`,
          source: "MERCHANT" as const,
          providerEventId: null,
          kind: "MERCHANT_STATUS_UPDATED" as const,
          verificationStatus: "MERCHANT_RECORDED" as const,
          observedAt,
          providerCreatedAt: null,
          summary: { localStatus: "PAID", trigger: "confirmed capture response" }
        }] : [])
      ]
    };
    await this.orders.save(updated);
    return updated;
  }
}
