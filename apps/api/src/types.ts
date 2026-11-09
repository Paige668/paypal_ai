export type OrderStatus = "CREATED" | "APPROVED" | "COMPLETED" | "FAILED";
export type MerchantLocalStatus = "PENDING_PAYMENT" | "PAID" | "CANCELLED";
export type PaymentEventSource = "PAYPAL_API" | "PAYPAL_WEBHOOK" | "MERCHANT" | "DEMO_INJECTION";
export type VerificationStatus = "API_RESPONSE" | "VERIFIED_WEBHOOK" | "MERCHANT_RECORDED" | "SIMULATED";

export interface PaymentEvent {
  evidenceId: string;
  source: PaymentEventSource;
  providerEventId: string | null;
  kind: "ORDER_CREATED" | "CAPTURE_COMPLETED" | "CAPTURE_OBSERVED" | "MERCHANT_STATUS_UPDATED" | "WEBHOOK_CAPTURE_COMPLETED" | "WEBHOOK_EVENT_OBSERVED" | "MERCHANT_UPDATE_FAILURE_INJECTED" | "DEMO_SCENARIO_RESET";
  verificationStatus: VerificationStatus;
  observedAt: string;
  providerCreatedAt: string | null;
  summary: Record<string, string>;
}

export interface MerchantOrder {
  merchantOrderId: string;
  paypalOrderId: string;
  paypalCaptureId: string | null;
  paypalOrderStatus: OrderStatus;
  paypalCaptureStatus: string | null;
  localStatus: MerchantLocalStatus;
  amount: { currencyCode: string; value: string };
  createdAt: string;
  updatedAt: string;
  captureObservedAt: string | null;
  merchantUpdateFailureInjected: boolean;
  scenarioRunId: string | null;
  evidence: PaymentEvent[];
}

export interface PaymentIncident {
  incidentId: string;
  merchantOrderId: string;
  scenarioRunId: string;
  type: "PAYMENT_CAPTURED_MERCHANT_PENDING";
  status: "OPEN" | "RESOLVED";
  detectedAt: string;
  captureEvidenceId: string;
  merchantStatusEvidenceId: string;
  reconciliationVersion: "MISMATCH_CAPTURED_PENDING@1";
}

export interface ScenarioRun {
  scenarioRunId: string;
  merchantOrderId: string;
  scenarioType: "MERCHANT_UPDATE_FAILURE";
  status: "ACTIVE" | "RESET";
  startedAt: string;
  replayOfScenarioRunId: string | null;
  incident: PaymentIncident | null;
}

export interface InvestigationEvidenceItem {
  evidenceId: string;
  source: PaymentEventSource;
  verificationStatus: VerificationStatus;
  observedAt: string;
  factType: PaymentEvent["kind"];
  sanitizedValue: Record<string, string>;
}

export interface InvestigationEvidencePack {
  incidentId: string;
  ruleId: "MISMATCH_CAPTURED_PENDING@1";
  incidentType: "PAYMENT_CAPTURED_MERCHANT_PENDING";
  detectedAt: string;
  externalCaptureStatus: string;
  merchantLocalStatusAtDetection: "PENDING_PAYMENT";
  merchantSuccessfulLocalStatus: "PAID";
  currentMerchantLocalStatus: MerchantLocalStatus;
  evidence: InvestigationEvidenceItem[];
}

export interface InvestigationReport {
  label: "AI-assisted analysis" | "Rule-based fallback";
  summary: string;
  facts: Array<{ statement: string; evidenceIds: string[] }>;
  hypotheses: Array<{ statement: string; confidence: "possible" | "likely"; evidenceIds: string[] }>;
  unknowns: string[];
  nextSteps: Array<{ action: string; reason: string; evidenceIds: string[] }>;
}

export interface StoredInvestigation {
  incidentId: string;
  status: "AI_GENERATED" | "FALLBACK";
  model: string | null;
  generatedAt: string;
  failureCode: "AI_NOT_CONFIGURED" | "AI_REQUEST_FAILED" | "AI_OUTPUT_INVALID" | null;
  report: InvestigationReport;
}

export interface OrderTimeline {
  merchantOrderId: string;
  paypalOrderId: string;
  localStatus: MerchantLocalStatus;
  externalCaptureStatus: string | null;
  events: PaymentEvent[];
}

export interface CreatePayPalOrderInput {
  merchantOrderId: string;
  currencyCode: string;
  value: string;
  requestId: string;
}

export interface CreatePayPalOrderResult {
  id: string;
  status: string;
}

export interface CapturePayPalOrderResult {
  orderId: string;
  orderStatus: string;
  captureId: string;
  captureStatus: string;
  currencyCode: string;
  value: string;
}

export interface VerifyPayPalWebhookInput {
  webhookId: string;
  transmissionId: string;
  transmissionTime: string;
  certUrl: string;
  authAlgo: string;
  transmissionSignature: string;
  event: Record<string, unknown>;
}

export interface VerifiedWebhookEvent {
  providerEventId: string;
  eventType: string;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  captureStatus: string | null;
  observedAt: string;
  providerCreatedAt: string | null;
  summary: Record<string, string>;
}

export type WebhookIngestStatus = "PROCESSED" | "DUPLICATE" | "QUARANTINED";

export interface PayPalGateway {
  createOrder(input: CreatePayPalOrderInput): Promise<CreatePayPalOrderResult>;
  captureOrder(paypalOrderId: string, requestId: string): Promise<CapturePayPalOrderResult>;
  verifyWebhookSignature(input: VerifyPayPalWebhookInput): Promise<boolean>;
}

export interface AiInvestigator {
  readonly model: string;
  investigate(evidencePack: InvestigationEvidencePack): Promise<unknown>;
}

export interface OrderRepository {
  save(order: MerchantOrder): Promise<void>;
  findByMerchantOrderId(id: string): Promise<MerchantOrder | null>;
  getTimeline(id: string): Promise<OrderTimeline | null>;
  recordVerifiedWebhook(event: VerifiedWebhookEvent): Promise<WebhookIngestStatus>;
  startMerchantFailureScenario(input: {
    merchantOrderId: string;
    scenarioRunId: string;
    observedAt: string;
    replayOfScenarioRunId: string | null;
  }): Promise<ScenarioRun | null>;
  resetMerchantFailureScenario(merchantOrderId: string, observedAt: string): Promise<MerchantOrder | null>;
  findScenarioRun(scenarioRunId: string): Promise<ScenarioRun | null>;
  createMismatchIncident(input: {
    merchantOrderId: string;
    scenarioRunId: string;
    detectedAt: string;
    captureEvidenceId: string;
    merchantStatusEvidenceId: string;
  }): Promise<PaymentIncident>;
  saveInvestigation(investigation: StoredInvestigation): Promise<void>;
  findInvestigation(incidentId: string): Promise<StoredInvestigation | null>;
}

