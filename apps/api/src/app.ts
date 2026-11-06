import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { PayPalApiError } from "./paypal.js";
import { createDemoRouter } from "./routes/demo-routes.js";
import { createInvestigationRouter } from "./routes/investigation-routes.js";
import { createOrderRouter } from "./routes/order-routes.js";
import { createWebhookRouter } from "./routes/webhook-routes.js";
import { OrderService, OrderServiceError } from "./services/order-service.js";
import { DemoService, DemoServiceError } from "./services/demo-service.js";
import { InvestigationService, InvestigationServiceError } from "./services/investigation-service.js";
import { WebhookService, WebhookServiceError } from "./services/webhook-service.js";
import type { AiInvestigator, OrderRepository, PayPalGateway } from "./types.js";

export function createApp(options: {
  paypal: PayPalGateway;
  orders: OrderRepository;
  paypalClientId: string;
  paypalWebhookId: string | undefined;
  webOrigin: string;
  demoMode?: boolean;
  reconciliationGraceMs?: number;
  investigator?: AiInvestigator;
  now?: () => Date;
}) {
  const app = express();
  const now = options.now ?? (() => new Date());
  const orderService = new OrderService(options.paypal, options.orders, now);
  const demoService = new DemoService(
    options.orders,
    options.demoMode ?? false,
    options.reconciliationGraceMs ?? 60_000,
    now
  );
  const investigationService = new InvestigationService(options.orders, options.investigator, now);
  const webhookService = new WebhookService(options.paypal, options.orders, options.paypalWebhookId, now);

  app.disable("x-powered-by");
  app.use(cors({ origin: options.webOrigin }));
  app.use("/api/webhooks/paypal", createWebhookRouter(webhookService));
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/health", (_request, response) => response.json({ status: "ok" }));
  app.get("/api/config/paypal", (_request, response) =>
    response.json({ clientId: options.paypalClientId, currency: "USD", environment: "sandbox" })
  );
  app.use("/api/orders", createOrderRouter(orderService));
  app.use("/api/demo", createDemoRouter(demoService));
  app.use("/api/investigations", createInvestigationRouter(investigationService));

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      return response.status(400).json({ error: "INVALID_REQUEST", issues: error.issues });
    }
    if (
      error instanceof OrderServiceError
      || error instanceof WebhookServiceError
      || error instanceof DemoServiceError
      || error instanceof InvestigationServiceError
    ) {
      return response.status(error.status).json({ error: error.code });
    }
    if (error instanceof PayPalApiError) {
      return response.status(502).json({ error: "PAYPAL_REQUEST_FAILED", debugId: error.debugId });
    }
    console.error("Unhandled API error", error instanceof Error ? error.message : "unknown");
    return response.status(500).json({ error: "INTERNAL_ERROR" });
  });

  return app;
}
