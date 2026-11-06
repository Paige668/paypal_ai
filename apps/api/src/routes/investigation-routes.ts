import { Router } from "express";
import type { InvestigationService } from "../services/investigation-service.js";

export function createInvestigationRouter(service: InvestigationService): Router {
  const router = Router();

  router.post("/scenarios/:scenarioRunId", async (request, response, next) => {
    try {
      response.json(await service.generate(request.params.scenarioRunId));
    } catch (error) {
      next(error);
    }
  });

  router.get("/scenarios/:scenarioRunId", async (request, response, next) => {
    try {
      const investigation = await service.get(request.params.scenarioRunId);
      if (!investigation) return response.status(404).json({ error: "INVESTIGATION_NOT_FOUND" });
      return response.json(investigation);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
