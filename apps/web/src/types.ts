export type EventSource = "PAYPAL_API" | "PAYPAL_WEBHOOK" | "MERCHANT" | "DEMO_INJECTION";

export type PaymentEvent = {
  evidenceId: string;
  source: EventSource;
  providerEventId: string | null;
  kind: string;
  verificationStatus: string;
  observedAt: string;
  providerCreatedAt: string | null;
  summary: Record<string, string>;
};

export type Order = {
  merchantOrderId: string;
  paypalOrderId: string;
  paypalCaptureId: string | null;
  paypalOrderStatus: string;
  paypalCaptureStatus: string | null;
  localStatus: "PENDING_PAYMENT" | "PAID" | "CANCELLED";
  amount: { currencyCode: string; value: string };
  captureObservedAt: string | null;
  merchantUpdateFailureInjected: boolean;
  scenarioRunId: string | null;
};

export type Timeline = {
  merchantOrderId: string;
  paypalOrderId: string;
  localStatus: Order["localStatus"];
  externalCaptureStatus: string | null;
  events: PaymentEvent[];
};

export type Incident = {
  incidentId: string;
  merchantOrderId: string;
  scenarioRunId: string;
  type: "PAYMENT_CAPTURED_MERCHANT_PENDING";
  status: "OPEN" | "RESOLVED";
  detectedAt: string;
  captureEvidenceId: string;
  merchantStatusEvidenceId: string;
  reconciliationVersion: string;
};

export type Scenario = {
  scenarioRunId: string;
  merchantOrderId: string;
  scenarioType: "MERCHANT_UPDATE_FAILURE";
  status: "ACTIVE" | "RESET";
  startedAt: string;
  replayOfScenarioRunId: string | null;
  incident: Incident | null;
};

export type Reconciliation =
  | { status: "NO_MISMATCH"; incident: null }
  | { status: "GRACE_PERIOD"; incident: null; eligibleAt: string }
  | { status: "INCIDENT_OPEN"; incident: Incident };

type CitedStatement = { statement: string; evidenceIds: string[] };

export type Investigation = {
  incidentId: string;
  status: "AI_GENERATED" | "FALLBACK";
  model: string | null;
  generatedAt: string;
  failureCode: "AI_NOT_CONFIGURED" | "AI_REQUEST_FAILED" | "AI_OUTPUT_INVALID" | null;
  report: {
    label: "AI-assisted analysis" | "Rule-based fallback";
    summary: string;
    facts: CitedStatement[];
    hypotheses: Array<CitedStatement & { confidence: "possible" | "likely" }>;
    unknowns: string[];
    nextSteps: Array<{ action: string; reason: string; evidenceIds: string[] }>;
  };
};

export type PublicConfig = {
  clientId: string;
  currency: string;
  demoMode: boolean;
  reconciliationGraceMs: number;
};
