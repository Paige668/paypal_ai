import { Router } from "express";
import { z } from "zod";
import type { OrderService } from "../services/order-service.js";

const createOrderSchema = z.object({
  currencyCode: z.string().regex(/^[A-Z]{3}$/).default("USD"),
  value: z.string().regex(/^\d{1,7}\.\d{2}$/)
});

export function createOrderRouter(service: OrderService): Router {
  const router = Router();

  router.post("/", async (request, response, next) => {
    try {
      const order = await service.create(createOrderSchema.parse(request.body));
      response.status(201).json(order);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:merchantOrderId", async (request, response, next) => {
    try {
      response.json(await service.get(request.params.merchantOrderId));
    } catch (error) {
      next(error);
    }
  });

  router.get("/:merchantOrderId/timeline", async (request, response, next) => {
    try {
      response.json(await service.getTimeline(request.params.merchantOrderId));
    } catch (error) {
      next(error);
    }
  });

  router.post("/:merchantOrderId/capture", async (request, response, next) => {
    try {
      response.json(await service.capture(request.params.merchantOrderId));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
