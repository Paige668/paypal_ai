import { Router } from "express";
import { z } from "zod";
import type { DemoService } from "../services/demo-service.js";

const injectSchema = z.object({ merchantOrderId: z.string().startsWith("ord_") });

export function createDemoRouter(service: DemoService): Router {
  const router = Router();

  router.post("/scenario-runs", async (request, response, next) => {
    try {
      const input = injectSchema.parse(request.body);
      response.status(201).json(await service.inject(input.merchantOrderId));
    } catch (error) {
      next(error);
    }
  });

  router.get("/scenario-runs/:scenarioRunId", async (request, response, next) => {
    try {
      response.json(await service.get(request.params.scenarioRunId));
    } catch (error) {
      next(error);
    }
  });

  router.post("/scenario-runs/:scenarioRunId/reconcile", async (request, response, next) => {
    try {
      response.json(await service.reconcile(request.params.scenarioRunId));
    } catch (error) {
      next(error);
    }
  });

  router.post("/scenario-runs/:scenarioRunId/replay", async (request, response, next) => {
    try {
      response.status(201).json(await service.replay(request.params.scenarioRunId));
    } catch (error) {
      next(error);
    }
  });

  router.post("/orders/:merchantOrderId/reset", async (request, response, next) => {
    try {
      response.json(await service.reset(request.params.merchantOrderId));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
