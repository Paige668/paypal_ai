import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type {
  AiInvestigator,
  InvestigationEvidencePack,
  MerchantOrder,
  OrderRepository,
  OrderTimeline,
  PaymentIncident,
  PayPalGateway,
  ScenarioRun,
  StoredInvestigation,
  VerifiedWebhookEvent,
  WebhookIngestStatus
} from "./types.js";

class MemoryOrders implements OrderRepository {
  private readonly values = new Map<string, MerchantOrder>();
  private readonly providerEventIds = new Set<string>();
  private readonly scenarios = new Map<string, ScenarioRun>();
  private readonly investigations = new Map<string, StoredInvestigation>();
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
  async startMerchantFailureScenario(input: {
    merchantOrderId: string;
    scenarioRunId: string;
    observedAt: string;
    replayOfScenarioRunId: string | null;
  }): Promise<ScenarioRun | null> {
    const order = this.values.get(input.merchantOrderId);
    if (!order) return null;
    for (const run of this.scenarios.values()) {
      if (run.merchantOrderId === order.merchantOrderId && run.status === "ACTIVE") {
        run.status = "RESET";
        if (run.incident) run.incident.status = "RESOLVED";
      }
    }
    order.merchantUpdateFailureInjected = true;
    order.scenarioRunId = input.scenarioRunId;
    order.updatedAt = input.observedAt;
    if (order.paypalCaptureStatus === "COMPLETED") order.localStatus = "PENDING_PAYMENT";
    order.evidence.push({
      evidenceId: `ev_demo_${input.scenarioRunId}`,
      source: "DEMO_INJECTION",
      providerEventId: null,
      kind: "MERCHANT_UPDATE_FAILURE_INJECTED",
      verificationStatus: "SIMULATED",
      observedAt: input.observedAt,
      providerCreatedAt: null,
      summary: {
        scenarioRunId: input.scenarioRunId,
        scenarioType: "MERCHANT_UPDATE_FAILURE",
        action: input.replayOfScenarioRunId ? "REPLAY" : "INJECT",
        localStatus: order.localStatus
      }
    });
    const run: ScenarioRun = {
      scenarioRunId: input.scenarioRunId,
      merchantOrderId: input.merchantOrderId,
      scenarioType: "MERCHANT_UPDATE_FAILURE",
      status: "ACTIVE",
      startedAt: input.observedAt,
      replayOfScenarioRunId: input.replayOfScenarioRunId,
      incident: null
    };
    this.scenarios.set(run.scenarioRunId, run);
    return structuredClone(run);
  }
  async resetMerchantFailureScenario(merchantOrderId: string, observedAt: string): Promise<MerchantOrder | null> {
    const order = this.values.get(merchantOrderId);
    if (!order) return null;
    const scenarioRunId = order.scenarioRunId;
    if (scenarioRunId) {
      const run = this.scenarios.get(scenarioRunId);
      if (run) {
        run.status = "RESET";
        if (run.incident) run.incident.status = "RESOLVED";
      }
      order.evidence.push({
        evidenceId: `ev_reset_${scenarioRunId}`,
        source: "DEMO_INJECTION",
        providerEventId: null,
        kind: "DEMO_SCENARIO_RESET",
        verificationStatus: "SIMULATED",
        observedAt,
        providerCreatedAt: null,
        summary: { scenarioRunId, localStatus: order.paypalCaptureStatus === "COMPLETED" ? "PAID" : order.localStatus }
      });
    }
    order.merchantUpdateFailureInjected = false;
    order.scenarioRunId = null;
    order.updatedAt = observedAt;
    if (order.paypalCaptureStatus === "COMPLETED") order.localStatus = "PAID";
    return structuredClone(order);
  }
  async findScenarioRun(id: string) { return structuredClone(this.scenarios.get(id) ?? null); }
  async createMismatchIncident(input: {
    merchantOrderId: string;
    scenarioRunId: string;
    detectedAt: string;
    captureEvidenceId: string;
    merchantStatusEvidenceId: string;
  }): Promise<PaymentIncident> {
    const run = this.scenarios.get(input.scenarioRunId)!;
    if (run.incident) return structuredClone(run.incident);
    const incident: PaymentIncident = {
      incidentId: `inc_${input.scenarioRunId}`,
      merchantOrderId: input.merchantOrderId,
      scenarioRunId: input.scenarioRunId,
      type: "PAYMENT_CAPTURED_MERCHANT_PENDING",
      status: "OPEN",
      detectedAt: input.detectedAt,
      captureEvidenceId: input.captureEvidenceId,
      merchantStatusEvidenceId: input.merchantStatusEvidenceId,
      reconciliationVersion: "MISMATCH_CAPTURED_PENDING@1"
    };
    run.incident = incident;
    return structuredClone(incident);
  }
  async saveInvestigation(investigation: StoredInvestigation) {
    this.investigations.set(investigation.incidentId, structuredClone(investigation));
  }
  async findInvestigation(incidentId: string) {
    return structuredClone(this.investigations.get(incidentId) ?? null);
  }
}

function setup(options: {
  webhookConfigured?: boolean;
  demoMode?: boolean;
  now?: () => Date;
  graceMs?: number;
  investigator?: AiInvestigator;
} = {}) {
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
    paypalWebhookId: options.webhookConfigured === false ? undefined : "WH-TEST-1",
    webOrigin: "http://localhost:5173",
    demoMode: options.demoMode,
    reconciliationGraceMs: options.graceMs,
    investigator: options.investigator,
    now: options.now ?? (() => new Date("2026-11-01T12:00:00.000Z"))
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
      supplementary_data: {
        related_ids: {
          order_id: paypalOrderId,
          authorization_id: "AUTHORIZATION-MUST-REACH-VERIFICATION"
        }
      },
      payer: { email_address: "must-not-be-stored@example.com" }
    }
  };
}

async function createDetectedScenario(app: ReturnType<typeof createApp>): Promise<string> {
  const created = await request(app).post("/api/orders").send({ currencyCode: "USD", value: "12.34" });
  const scenario = await request(app).post("/api/demo/scenario-runs").send({ merchantOrderId: created.body.merchantOrderId });
  await request(app).post(`/api/orders/${created.body.merchantOrderId}/capture`).send({});
  await request(app).post(`/api/demo/scenario-runs/${scenario.body.scenarioRunId}/reconcile`);
  return scenario.body.scenarioRunId as string;
}

describe("orders API", () => {
  it("exposes only public demo configuration to the browser", async () => {
    const { app } = setup({ demoMode: true, graceMs: 5_000 });
    const response = await request(app).get("/api/config/paypal");

    expect(response.body).toEqual({
      clientId: "public-sandbox-id",
      currency: "USD",
      environment: "sandbox",
      demoMode: true,
      reconciliationGraceMs: 5_000
    });
    expect(JSON.stringify(response.body)).not.toContain("secret");
    expect(JSON.stringify(response.body)).not.toContain("OPENAI_API_KEY");
  });

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
    expect(vi.mocked(paypal.verifyWebhookSignature).mock.calls[0]?.[0].event).toEqual(
      captureCompletedWebhook()
    );
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
    const { app, paypal } = setup({ webhookConfigured: false });
    const response = await request(app)
      .post("/api/webhooks/paypal")
      .set("Content-Type", "application/json")
      .send(captureCompletedWebhook());

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "PAYPAL_WEBHOOK_NOT_CONFIGURED" });
    expect(paypal.verifyWebhookSignature).not.toHaveBeenCalled();
  });

  it("reproduces and detects the merchant-only fault after grace without another PayPal mutation", async () => {
    let now = new Date("2026-11-05T10:00:00.000Z");
    const { app, paypal } = setup({ demoMode: true, graceMs: 60_000, now: () => now });
    const created = await request(app).post("/api/orders").send({ currencyCode: "USD", value: "12.34" });
    const injected = await request(app).post("/api/demo/scenario-runs").send({ merchantOrderId: created.body.merchantOrderId });
    const scenarioRunId = injected.body.scenarioRunId as string;

    const captured = await request(app).post(`/api/orders/${created.body.merchantOrderId}/capture`).send({});
    expect(captured.body).toMatchObject({ paypalCaptureStatus: "COMPLETED", localStatus: "PENDING_PAYMENT" });
    expect((await request(app).post(`/api/demo/scenario-runs/${scenarioRunId}/reconcile`)).body.status).toBe("GRACE_PERIOD");

    now = new Date("2026-11-05T10:01:01.000Z");
    const detected = await request(app).post(`/api/demo/scenario-runs/${scenarioRunId}/reconcile`);
    const repeated = await request(app).post(`/api/demo/scenario-runs/${scenarioRunId}/reconcile`);
    expect(detected.body).toMatchObject({ status: "INCIDENT_OPEN", incident: { type: "PAYMENT_CAPTURED_MERCHANT_PENDING" } });
    expect(repeated.body.incident.incidentId).toBe(detected.body.incident.incidentId);

    const createCallsBeforeReplay = vi.mocked(paypal.createOrder).mock.calls.length;
    const captureCallsBeforeReplay = vi.mocked(paypal.captureOrder).mock.calls.length;
    const replay = await request(app).post(`/api/demo/scenario-runs/${scenarioRunId}/replay`).send({});
    expect(replay.status).toBe(201);
    expect(replay.body.scenarioRunId).not.toBe(scenarioRunId);
    expect(replay.body.replayOfScenarioRunId).toBe(scenarioRunId);
    expect(paypal.createOrder).toHaveBeenCalledTimes(createCallsBeforeReplay);
    expect(paypal.captureOrder).toHaveBeenCalledTimes(captureCallsBeforeReplay);

    const replayScenarioRunId = replay.body.scenarioRunId as string;
    now = new Date("2026-11-05T10:02:02.000Z");
    const replayDetected = await request(app).post(`/api/demo/scenario-runs/${replayScenarioRunId}/reconcile`);
    expect(replayDetected.body).toMatchObject({
      status: "INCIDENT_OPEN",
      incident: { type: "PAYMENT_CAPTURED_MERCHANT_PENDING" }
    });
    expect(replayDetected.body.incident.incidentId).not.toBe(detected.body.incident.incidentId);
    expect(paypal.createOrder).toHaveBeenCalledTimes(createCallsBeforeReplay);
    expect(paypal.captureOrder).toHaveBeenCalledTimes(captureCallsBeforeReplay);

    const reset = await request(app).post(`/api/demo/orders/${created.body.merchantOrderId}/reset`).send({});
    expect(reset.body).toMatchObject({ localStatus: "PAID", merchantUpdateFailureInjected: false, scenarioRunId: null });
    expect(paypal.createOrder).toHaveBeenCalledTimes(createCallsBeforeReplay);
    expect(paypal.captureOrder).toHaveBeenCalledTimes(captureCallsBeforeReplay);
  });

  it("denies demo controls by default", async () => {
    const { app, paypal } = setup();
    const response = await request(app).post("/api/demo/scenario-runs").send({ merchantOrderId: "ord_blocked" });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "DEMO_MODE_DISABLED" });
    expect(paypal.createOrder).not.toHaveBeenCalled();
    expect(paypal.captureOrder).not.toHaveBeenCalled();
  });

  it("starts the grace period when a fault is injected against an older completed capture", async () => {
    let now = new Date("2026-11-05T09:00:00.000Z");
    const { app } = setup({ demoMode: true, graceMs: 60_000, now: () => now });
    const created = await request(app).post("/api/orders").send({ currencyCode: "USD", value: "12.34" });
    await request(app).post(`/api/orders/${created.body.merchantOrderId}/capture`).send({});

    now = new Date("2026-11-05T10:00:00.000Z");
    const injected = await request(app).post("/api/demo/scenario-runs").send({ merchantOrderId: created.body.merchantOrderId });
    const result = await request(app).post(`/api/demo/scenario-runs/${injected.body.scenarioRunId}/reconcile`);

    expect(result.body).toEqual({
      status: "GRACE_PERIOD",
      incident: null,
      eligibleAt: "2026-11-05T10:01:00.000Z"
    });
  });

  it("returns and persists an evidence-grounded structured AI investigation", async () => {
    const investigator: AiInvestigator = {
      model: "test-model",
      investigate: vi.fn(async (pack) => ({
        label: "AI-assisted analysis",
        summary: "The provider and merchant states disagree after the configured grace period.",
        facts: pack.evidence.map((item) => ({ statement: `Observed ${item.factType}.`, evidenceIds: [item.evidenceId] })),
        hypotheses: [{
          statement: "The merchant update handler may have skipped its local transition.",
          confidence: "likely",
          evidenceIds: [pack.evidence.find((item) => item.factType === "MERCHANT_UPDATE_FAILURE_INJECTED")!.evidenceId]
        }],
        unknowns: ["Other provider deliveries outside retained evidence are unknown."],
        nextSteps: [{
          action: "Inspect the merchant handler transaction boundary.",
          reason: "Confirm where the local transition was skipped.",
          evidenceIds: []
        }]
      }))
    };
    const { app } = setup({ demoMode: true, graceMs: 0, investigator });
    const scenarioRunId = await createDetectedScenario(app);

    const generated = await request(app).post(`/api/investigations/scenarios/${scenarioRunId}`).send({});
    const stored = await request(app).get(`/api/investigations/scenarios/${scenarioRunId}`);

    expect(generated.body).toMatchObject({
      status: "AI_GENERATED",
      model: "test-model",
      failureCode: null,
      report: { label: "AI-assisted analysis" }
    });
    expect(stored.body).toEqual(generated.body);
    expect(investigator.investigate).toHaveBeenCalledTimes(1);
    const sentPack = vi.mocked(investigator.investigate).mock.calls[0]![0];
    expect(JSON.stringify(sentPack)).not.toContain("paypalOrderId");
    expect(JSON.stringify(sentPack)).not.toContain("captureId");
  });

  it("requests one correction for invalid output and accepts read-only inspection wording", async () => {
    const investigator: AiInvestigator = {
      model: "test-model",
      investigate: vi.fn()
        .mockResolvedValueOnce({
          label: "AI-assisted analysis",
          summary: "Unsupported first attempt.",
          facts: [{ statement: "Fabricated fact.", evidenceIds: ["ev_does_not_exist"] }],
          hypotheses: [],
          unknowns: [],
          nextSteps: []
        })
        .mockImplementationOnce(async (pack: InvestigationEvidencePack) => ({
          label: "AI-assisted analysis",
          summary: "The external capture succeeded but the merchant-local transition did not.",
          facts: pack.evidence.map((item) => ({ statement: `Observed ${item.factType}.`, evidenceIds: [item.evidenceId] })),
          hypotheses: [],
          unknowns: [],
          nextSteps: [{
            action: "Inspect why the handler failed to update the order status to PAID.",
            reason: "This is a read-only check of the merchant-owned transition.",
            evidenceIds: []
          }]
        }))
    };
    const { app } = setup({ demoMode: true, graceMs: 0, investigator });
    const scenarioRunId = await createDetectedScenario(app);

    const response = await request(app).post(`/api/investigations/scenarios/${scenarioRunId}`).send({});

    expect(response.body).toMatchObject({ status: "AI_GENERATED", failureCode: null });
    expect(investigator.investigate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(investigator.investigate).mock.calls[1]![1]).toContain("UNKNOWN_EVIDENCE_ID");
  });

  it("still rejects a direct merchant payment-state mutation", async () => {
    const investigator: AiInvestigator = {
      model: "test-model",
      investigate: vi.fn(async (pack) => ({
        label: "AI-assisted analysis",
        summary: "The external and merchant-local states disagree.",
        facts: pack.evidence.map((item) => ({ statement: `Observed ${item.factType}.`, evidenceIds: [item.evidenceId] })),
        hypotheses: [],
        unknowns: [],
        nextSteps: [{
          action: "Update the order status to PAID.",
          reason: "Unsafe mutation.",
          evidenceIds: []
        }]
      }))
    };
    const { app } = setup({ demoMode: true, graceMs: 0, investigator });
    const scenarioRunId = await createDetectedScenario(app);

    const response = await request(app).post(`/api/investigations/scenarios/${scenarioRunId}`).send({});

    expect(response.body).toMatchObject({ status: "FALLBACK", failureCode: "AI_OUTPUT_INVALID" });
    expect(investigator.investigate).toHaveBeenCalledTimes(2);
  });

  it("rejects fabricated evidence citations and stores a grounded fallback", async () => {
    const investigator: AiInvestigator = {
      model: "test-model",
      investigate: vi.fn().mockResolvedValue({
        label: "AI-assisted analysis",
        summary: "Unsupported output.",
        facts: [{ statement: "Fabricated fact.", evidenceIds: ["ev_does_not_exist"] }],
        hypotheses: [],
        unknowns: [],
        nextSteps: []
      })
    };
    const { app } = setup({ demoMode: true, graceMs: 0, investigator });
    const scenarioRunId = await createDetectedScenario(app);

    const response = await request(app).post(`/api/investigations/scenarios/${scenarioRunId}`).send({});

    expect(response.body).toMatchObject({
      status: "FALLBACK",
      failureCode: "AI_OUTPUT_INVALID",
      report: { label: "Rule-based fallback", hypotheses: [] }
    });
    expect(JSON.stringify(response.body)).not.toContain("Fabricated fact");
  });

  it("rejects AI output that conflates PayPal and merchant-local success states", async () => {
    const investigator: AiInvestigator = {
      model: "test-model",
      investigate: vi.fn(async (pack) => ({
        label: "AI-assisted analysis",
        summary: "The provider and merchant states disagree.",
        facts: pack.evidence.map((item) => ({ statement: `Observed ${item.factType}.`, evidenceIds: [item.evidenceId] })),
        hypotheses: [{
          statement: "The merchant-side update that sets the local payment status to 'COMPLETED' may have failed.",
          confidence: "likely",
          evidenceIds: []
        }],
        unknowns: [],
        nextSteps: []
      }))
    };
    const { app } = setup({ demoMode: true, graceMs: 0, investigator });
    const scenarioRunId = await createDetectedScenario(app);

    const response = await request(app).post(`/api/investigations/scenarios/${scenarioRunId}`).send({});

    expect(response.body).toMatchObject({
      status: "FALLBACK",
      failureCode: "AI_OUTPUT_INVALID",
      report: { label: "Rule-based fallback" }
    });
    expect(JSON.stringify(response.body)).not.toContain("local payment status to 'COMPLETED'");
  });

  it("keeps deterministic findings available when the AI request fails", async () => {
    const investigator: AiInvestigator = {
      model: "test-model",
      investigate: vi.fn().mockRejectedValue(new Error("timeout"))
    };
    const { app } = setup({ demoMode: true, graceMs: 0, investigator });
    const scenarioRunId = await createDetectedScenario(app);

    const response = await request(app).post(`/api/investigations/scenarios/${scenarioRunId}`).send({});

    expect(response.body).toMatchObject({
      status: "FALLBACK",
      failureCode: "AI_REQUEST_FAILED",
      report: {
        label: "Rule-based fallback",
        facts: expect.arrayContaining([expect.objectContaining({ evidenceIds: expect.any(Array) })])
      }
    });
  });

  it("returns an explicit rule-based fallback when no AI key is configured", async () => {
    const { app } = setup({ demoMode: true, graceMs: 0 });
    const scenarioRunId = await createDetectedScenario(app);

    const response = await request(app).post(`/api/investigations/scenarios/${scenarioRunId}`).send({});

    expect(response.body).toMatchObject({
      status: "FALLBACK",
      model: null,
      failureCode: "AI_NOT_CONFIGURED",
      report: { label: "Rule-based fallback" }
    });
  });
});

