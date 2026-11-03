import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { PayPalApiError } from "./paypal.js";
import type { MerchantOrder, OrderRepository, PayPalGateway } from "./types.js";

const createOrderSchema = z.object({
  currencyCode: z.string().regex(/^[A-Z]{3}$/).default("USD"),
  value: z.string().regex(/^\d{1,7}\.\d{2}$/)
});

export function createApp(options: {
  paypal: PayPalGateway;
  orders: OrderRepository;
  paypalClientId: string;
  webOrigin: string;
  now?: () => Date;
}) {
  const app = express();
  const now = options.now ?? (() => new Date());
  app.disable("x-powered-by");
  app.use(cors({ origin: options.webOrigin }));
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/health", (_request, response) => response.json({ status: "ok" }));
  app.get("/api/config/paypal", (_request, response) =>
    response.json({ clientId: options.paypalClientId, currency: "USD", environment: "sandbox" })
  );

  app.post("/api/orders", async (request, response, next) => {
    try {
      const input = createOrderSchema.parse(request.body);
      const merchantOrderId = `ord_${randomUUID()}`;
      const paypalOrder = await options.paypal.createOrder({
        merchantOrderId,
        currencyCode: input.currencyCode,
        value: input.value,
        requestId: `create-${merchantOrderId}`
      });
      const observedAt = now().toISOString();
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
        evidence: [
          {
            evidenceId: `ev_${randomUUID()}`,
            source: "PAYPAL_API",
            providerEventId: null,
            kind: "ORDER_CREATED",
            verificationStatus: "API_RESPONSE",
            observedAt,
            providerCreatedAt: null,
            summary: { paypalOrderId: paypalOrder.id, status: paypalOrder.status }
          }
        ]
      };
      await options.orders.save(order);
      response.status(201).json(order);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/orders/:merchantOrderId", async (request, response, next) => {
    try {
      const order = await options.orders.findByMerchantOrderId(request.params.merchantOrderId);
      if (!order) return response.status(404).json({ error: "ORDER_NOT_FOUND" });
      return response.json(order);
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/orders/:merchantOrderId/timeline", async (request, response, next) => {
    try {
      const timeline = await options.orders.getTimeline(request.params.merchantOrderId);
      if (!timeline) return response.status(404).json({ error: "ORDER_NOT_FOUND" });
      return response.json(timeline);
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/orders/:merchantOrderId/capture", async (request, response, next) => {
    try {
      const order = await options.orders.findByMerchantOrderId(request.params.merchantOrderId);
      if (!order) return response.status(404).json({ error: "ORDER_NOT_FOUND" });
      if (order.paypalCaptureId) return response.json(order);
      const result = await options.paypal.captureOrder(order.paypalOrderId, `capture-${order.merchantOrderId}`);
      if (result.orderId !== order.paypalOrderId) {
        return response.status(409).json({ error: "PAYPAL_ORDER_MAPPING_MISMATCH" });
      }
      const observedAt = now().toISOString();
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
      await options.orders.save(updated);
      return response.json(updated);
    } catch (error) {
      return next(error);
    }
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      return response.status(400).json({ error: "INVALID_REQUEST", issues: error.issues });
    }
    if (error instanceof PayPalApiError) {
      return response.status(502).json({ error: "PAYPAL_REQUEST_FAILED", debugId: error.debugId });
    }
    console.error("Unhandled API error", error instanceof Error ? error.message : "unknown");
    return response.status(500).json({ error: "INTERNAL_ERROR" });
  });

  return app;
}

