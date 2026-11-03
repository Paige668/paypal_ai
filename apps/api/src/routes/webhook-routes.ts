import express, { Router } from "express";
import type { WebhookService } from "../services/webhook-service.js";

export function createWebhookRouter(service: WebhookService): Router {
  const router = Router();

  router.post("/", express.raw({ type: "application/json", limit: "64kb" }), async (request, response, next) => {
    try {
      if (!Buffer.isBuffer(request.body)) {
        return response.status(400).json({ error: "INVALID_WEBHOOK_BODY" });
      }
      const status = await service.process(request.body, {
        "paypal-transmission-id": request.get("paypal-transmission-id"),
        "paypal-transmission-time": request.get("paypal-transmission-time"),
        "paypal-cert-url": request.get("paypal-cert-url"),
        "paypal-auth-algo": request.get("paypal-auth-algo"),
        "paypal-transmission-sig": request.get("paypal-transmission-sig")
      });
      return response.status(status === "QUARANTINED" ? 202 : 200).json({ status });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
