import { randomUUID } from "node:crypto";
import type { MerchantOrder, OrderRepository, PaymentIncident, ScenarioRun } from "../types.js";

export class DemoServiceError extends Error {
  constructor(
    readonly code: "DEMO_MODE_DISABLED" | "ORDER_NOT_FOUND" | "SCENARIO_NOT_FOUND" | "CAPTURE_REQUIRED" | "SCENARIO_NOT_ACTIVE",
    readonly status: number
  ) {
    super(code);
    this.name = "DemoServiceError";
  }
}

export type ReconciliationResult =
  | { status: "NO_MISMATCH"; incident: null }
  | { status: "GRACE_PERIOD"; incident: null; eligibleAt: string }
  | { status: "INCIDENT_OPEN"; incident: PaymentIncident };

export class DemoService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly enabled: boolean,
    private readonly gracePeriodMs: number,
    private readonly now: () => Date
  ) {}

  async inject(merchantOrderId: string): Promise<ScenarioRun> {
    this.assertEnabled();
    await this.requireOrder(merchantOrderId);
    const scenarioRunId = `scenario_${randomUUID()}`;
    const run = await this.orders.startMerchantFailureScenario({
      merchantOrderId,
      scenarioRunId,
      observedAt: this.now().toISOString(),
      replayOfScenarioRunId: null
    });
    if (!run) throw new DemoServiceError("ORDER_NOT_FOUND", 404);
    return run;
  }

  async replay(scenarioRunId: string): Promise<ScenarioRun> {
    this.assertEnabled();
    const original = await this.orders.findScenarioRun(scenarioRunId);
    if (!original) throw new DemoServiceError("SCENARIO_NOT_FOUND", 404);
    const order = await this.requireOrder(original.merchantOrderId);
    if (order.paypalCaptureStatus !== "COMPLETED" || !order.paypalCaptureId) {
      throw new DemoServiceError("CAPTURE_REQUIRED", 409);
    }
    const replayRunId = `scenario_${randomUUID()}`;
    const replay = await this.orders.startMerchantFailureScenario({
      merchantOrderId: original.merchantOrderId,
      scenarioRunId: replayRunId,
      observedAt: this.now().toISOString(),
      replayOfScenarioRunId: original.scenarioRunId
    });
    if (!replay) throw new DemoServiceError("ORDER_NOT_FOUND", 404);
    return replay;
  }

  async get(scenarioRunId: string): Promise<ScenarioRun> {
    this.assertEnabled();
    const run = await this.orders.findScenarioRun(scenarioRunId);
    if (!run) throw new DemoServiceError("SCENARIO_NOT_FOUND", 404);
    return run;
  }

  async reset(merchantOrderId: string): Promise<MerchantOrder> {
    this.assertEnabled();
    const order = await this.orders.resetMerchantFailureScenario(merchantOrderId, this.now().toISOString());
    if (!order) throw new DemoServiceError("ORDER_NOT_FOUND", 404);
    return order;
  }

  async reconcile(scenarioRunId: string): Promise<ReconciliationResult> {
    this.assertEnabled();
    const run = await this.get(scenarioRunId);
    if (run.status !== "ACTIVE") throw new DemoServiceError("SCENARIO_NOT_ACTIVE", 409);
    if (run.incident) return { status: "INCIDENT_OPEN", incident: run.incident };

    const order = await this.requireOrder(run.merchantOrderId);
    if (order.paypalCaptureStatus !== "COMPLETED" || order.localStatus !== "PENDING_PAYMENT") {
      return { status: "NO_MISMATCH", incident: null };
    }
    if (!order.captureObservedAt) return { status: "NO_MISMATCH", incident: null };
    const mismatchObservedAtMs = Math.max(
      new Date(order.captureObservedAt).getTime(),
      new Date(run.startedAt).getTime()
    );
    const eligibleAtMs = mismatchObservedAtMs + this.gracePeriodMs;
    if (this.now().getTime() < eligibleAtMs) {
      return { status: "GRACE_PERIOD", incident: null, eligibleAt: new Date(eligibleAtMs).toISOString() };
    }

    const captureEvidence = order.evidence.find((event) =>
      (event.kind === "CAPTURE_COMPLETED" || event.kind === "WEBHOOK_CAPTURE_COMPLETED")
      && event.summary.status === "COMPLETED"
    );
    const merchantEvidence = order.evidence.find((event) =>
      event.kind === "MERCHANT_UPDATE_FAILURE_INJECTED"
      && event.summary.scenarioRunId === scenarioRunId
    );
    if (!captureEvidence || !merchantEvidence) return { status: "NO_MISMATCH", incident: null };

    const incident = await this.orders.createMismatchIncident({
      merchantOrderId: order.merchantOrderId,
      scenarioRunId,
      detectedAt: this.now().toISOString(),
      captureEvidenceId: captureEvidence.evidenceId,
      merchantStatusEvidenceId: merchantEvidence.evidenceId
    });
    return { status: "INCIDENT_OPEN", incident };
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new DemoServiceError("DEMO_MODE_DISABLED", 403);
  }

  private async requireOrder(merchantOrderId: string): Promise<MerchantOrder> {
    const order = await this.orders.findByMerchantOrderId(merchantOrderId);
    if (!order) throw new DemoServiceError("ORDER_NOT_FOUND", 404);
    return order;
  }
}
