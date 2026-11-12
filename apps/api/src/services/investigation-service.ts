import { z } from "zod";
import type {
  AiInvestigator,
  InvestigationEvidencePack,
  InvestigationReport,
  MerchantOrder,
  OrderRepository,
  PaymentIncident,
  StoredInvestigation
} from "../types.js";

const citedStatementSchema = z.object({
  statement: z.string().min(1).max(220),
  evidenceIds: z.array(z.string().startsWith("ev_")).min(1)
}).strict();

export const investigationReportSchema = z.object({
  label: z.literal("AI-assisted analysis"),
  summary: z.string().min(1).max(260),
  facts: z.array(citedStatementSchema).max(3),
  hypotheses: z.array(z.object({
    statement: z.string().min(1).max(220),
    confidence: z.enum(["possible", "likely"]),
    evidenceIds: z.array(z.string().startsWith("ev_")).max(10)
  }).strict()).max(3),
  unknowns: z.array(z.string().min(1).max(220)).max(3),
  nextSteps: z.array(z.object({
    action: z.string().min(1).max(180),
    reason: z.string().min(1).max(220),
    evidenceIds: z.array(z.string().startsWith("ev_")).max(10)
  }).strict()).max(3)
}).strict();

const safeSummaryKeys = new Set([
  "status",
  "localStatus",
  "trigger",
  "eventType",
  "scenarioType",
  "action",
  "currencyCode",
  "value"
]);

function sanitizeSummary(summary: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(summary).filter(([key]) => safeSummaryKeys.has(key)));
}

export function buildEvidencePack(order: MerchantOrder, incident: PaymentIncident): InvestigationEvidencePack {
  const directlyRelevant = new Set([incident.captureEvidenceId, incident.merchantStatusEvidenceId]);
  const evidence = order.evidence
    .filter((event) => directlyRelevant.has(event.evidenceId) || event.kind === "WEBHOOK_CAPTURE_COMPLETED")
    .map((event) => ({
      evidenceId: event.evidenceId,
      source: event.source,
      verificationStatus: event.verificationStatus,
      observedAt: event.observedAt,
      factType: event.kind,
      sanitizedValue: sanitizeSummary(event.summary)
    }));
  return {
    incidentId: incident.incidentId,
    ruleId: incident.reconciliationVersion,
    incidentType: incident.type,
    detectedAt: incident.detectedAt,
    externalCaptureStatus: order.paypalCaptureStatus ?? "UNKNOWN",
    merchantLocalStatusAtDetection: "PENDING_PAYMENT",
    merchantSuccessfulLocalStatus: "PAID",
    currentMerchantLocalStatus: order.localStatus,
    evidence
  };
}

export function validateGroundedReport(value: unknown, pack: InvestigationEvidencePack): InvestigationReport {
  const report = investigationReportSchema.parse(value);
  const knownEvidenceIds = new Set(pack.evidence.map((item) => item.evidenceId));
  const citations = [
    ...report.facts.flatMap((item) => item.evidenceIds),
    ...report.hypotheses.flatMap((item) => item.evidenceIds),
    ...report.nextSteps.flatMap((item) => item.evidenceIds)
  ];
  if (citations.some((evidenceId) => !knownEvidenceIds.has(evidenceId))) {
    throw new Error("UNKNOWN_EVIDENCE_ID");
  }
  const reportText = [
    report.summary,
    ...report.facts.map((item) => item.statement),
    ...report.hypotheses.map((item) => item.statement),
    ...report.unknowns,
    ...report.nextSteps.flatMap((item) => [item.action, item.reason])
  ].join("\n");
  const merchantCompleted = /\b(?:merchant(?:-local|-side| local)?|local(?: payment)?)\b.{0,50}\b(?:state|status)\b\s*(?:=|:|is|was|to|as|be|become|becomes|became|set to)\s*["'`]?COMPLETED\b/i;
  if (merchantCompleted.test(reportText)) {
    throw new Error("STATE_BOUNDARY_CONFLATION");
  }
  const financialMutation = /^\s*(?:(?:manually|automatically|directly)\s+)?(?:(?:issue|initiate|retry|repeat|create|trigger)\b.{0,40}\b(?:refund|capture|charge|payment)\b|(?:mark|set|update)\b.{0,40}\b(?:paid|payment status|order status)\b)/i;
  if (report.nextSteps.some((item) => financialMutation.test(item.action))) {
    throw new Error("UNSAFE_NEXT_STEP");
  }
  return report;
}

function fallbackReport(pack: InvestigationEvidencePack): InvestigationReport {
  const capture = pack.evidence.find((item) =>
    item.factType === "CAPTURE_COMPLETED" || item.factType === "WEBHOOK_CAPTURE_COMPLETED"
  );
  const merchant = pack.evidence.find((item) => item.factType === "MERCHANT_UPDATE_FAILURE_INJECTED");
  const facts: InvestigationReport["facts"] = [];
  if (capture) facts.push({ statement: "The retained provider evidence reports a completed capture.", evidenceIds: [capture.evidenceId] });
  if (merchant) facts.push({ statement: "A merchant-side update failure was explicitly injected for this demo scenario.", evidenceIds: [merchant.evidenceId] });
  return {
    label: "Rule-based fallback",
    summary: pack.currentMerchantLocalStatus === "PENDING_PAYMENT"
      ? "AI analysis is unavailable. The deterministic incident records a completed external capture and a merchant-local order that remains pending."
      : `AI analysis is unavailable. The deterministic incident recorded a completed external capture and a pending merchant-local order at detection time. The current merchant-local status is ${pack.currentMerchantLocalStatus}.`,
    facts,
    hypotheses: [],
    unknowns: ["Provider event delivery outside the retained application evidence is not established."],
    nextSteps: [{
      action: "Inspect the merchant status-update handler and its transaction boundary.",
      reason: "The mismatch is inside merchant-owned state processing; this check does not mutate the payment.",
      evidenceIds: merchant ? [merchant.evidenceId] : []
    }]
  };
}

export class InvestigationServiceError extends Error {
  constructor(readonly code: "SCENARIO_NOT_FOUND" | "INCIDENT_REQUIRED" | "ORDER_NOT_FOUND", readonly status: number) {
    super(code);
    this.name = "InvestigationServiceError";
  }
}

function validationFailureMessage(cause: unknown): string {
  return cause instanceof z.ZodError
    ? cause.issues.map((issue) => `${issue.path.join(".") || "report"}: ${issue.message}`).join("; ")
    : cause instanceof Error ? cause.message : "UNKNOWN_VALIDATION_FAILURE";
}

export class InvestigationService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly investigator: AiInvestigator | undefined,
    private readonly now: () => Date
  ) {}

  async generate(scenarioRunId: string): Promise<StoredInvestigation> {
    const run = await this.orders.findScenarioRun(scenarioRunId);
    if (!run) throw new InvestigationServiceError("SCENARIO_NOT_FOUND", 404);
    if (!run.incident) throw new InvestigationServiceError("INCIDENT_REQUIRED", 409);
    const order = await this.orders.findByMerchantOrderId(run.merchantOrderId);
    if (!order) throw new InvestigationServiceError("ORDER_NOT_FOUND", 404);
    const pack = buildEvidencePack(order, run.incident);

    let investigation: StoredInvestigation;
    if (!this.investigator) {
      investigation = this.fallback(run.incident.incidentId, pack, "AI_NOT_CONFIGURED");
    } else {
      try {
        const raw = await this.investigator.investigate(pack);
        let report: InvestigationReport;
        try {
          report = validateGroundedReport(raw, pack);
        } catch (firstCause) {
          const firstFailure = validationFailureMessage(firstCause);
          console.warn("AI investigation output rejected; requesting one correction:", firstFailure);
          try {
            const correctedRaw = await this.investigator.investigate(pack, firstFailure);
            report = validateGroundedReport(correctedRaw, pack);
          } catch (secondCause) {
            console.warn("Corrected AI investigation output rejected:", validationFailureMessage(secondCause));
            investigation = this.fallback(run.incident.incidentId, pack, "AI_OUTPUT_INVALID");
            await this.orders.saveInvestigation(investigation);
            return investigation;
          }
        }
        investigation = {
          incidentId: run.incident.incidentId,
          status: "AI_GENERATED",
          model: this.investigator.model,
          generatedAt: this.now().toISOString(),
          failureCode: null,
          report
        };
      } catch {
        investigation = this.fallback(run.incident.incidentId, pack, "AI_REQUEST_FAILED");
      }
    }
    await this.orders.saveInvestigation(investigation);
    return investigation;
  }

  async get(scenarioRunId: string): Promise<StoredInvestigation | null> {
    const run = await this.orders.findScenarioRun(scenarioRunId);
    if (!run) throw new InvestigationServiceError("SCENARIO_NOT_FOUND", 404);
    if (!run.incident) return null;
    return this.orders.findInvestigation(run.incident.incidentId);
  }

  private fallback(
    incidentId: string,
    pack: InvestigationEvidencePack,
    failureCode: NonNullable<StoredInvestigation["failureCode"]>
  ): StoredInvestigation {
    return {
      incidentId,
      status: "FALLBACK",
      model: this.investigator?.model ?? null,
      generatedAt: this.now().toISOString(),
      failureCode,
      report: fallbackReport(pack)
    };
  }
}
