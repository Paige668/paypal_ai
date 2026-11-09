import type { EventSource, Order } from "./types";

export const provenance: Record<EventSource, { label: string; tone: string }> = {
  PAYPAL_API: { label: "Sandbox PayPal API", tone: "provider" },
  PAYPAL_WEBHOOK: { label: "Verified PayPal Webhook", tone: "verified" },
  MERCHANT: { label: "Merchant", tone: "merchant" },
  DEMO_INJECTION: { label: "Simulated merchant fault", tone: "simulated" }
};

export function workflowStage(order: Order | null, hasScenario: boolean, hasIncident: boolean): number {
  if (!order?.paypalCaptureId) return 1;
  if (!hasScenario) return 2;
  if (!hasIncident) return 3;
  return 4;
}

export function friendlyError(code: string): string {
  const messages: Record<string, string> = {
    DEMO_MODE_DISABLED: "Demo controls are disabled. Set DEMO_MODE=true on the API server and restart it.",
    CAPTURE_REQUIRED: "Complete a Sandbox capture before starting this merchant-only scenario.",
    INCIDENT_REQUIRED: "Run reconciliation until a deterministic incident is open before generating a report.",
    SCENARIO_NOT_ACTIVE: "This scenario has already been reset. Start or replay a scenario to continue.",
    AI_NOT_CONFIGURED: "AI is not configured; the server will return a grounded rule-based report.",
    INVALID_REQUEST: "Check the submitted values and try again.",
    PAYPAL_REQUEST_FAILED: "PayPal Sandbox did not accept the request. Check the API log and Sandbox configuration.",
    INTERNAL_ERROR: "The API could not complete the request. Check the server log and try again.",
    ORDER_NOT_FOUND: "The selected merchant order no longer exists.",
    SCENARIO_NOT_FOUND: "The selected scenario no longer exists."
  };
  return messages[code] ?? code.replaceAll("_", " ").toLowerCase();
}

export function amountValidationMessage(value: string): string | null {
  if (!/^\d{1,7}\.\d{2}$/.test(value)) return "Enter 0.01–9,999,999.99 USD with exactly two decimal places.";
  if (Number(value) <= 0) return "Amount must be greater than 0.00 USD.";
  return null;
}

export function graceSecondsRemaining(eligibleAt: string | null, nowMs: number): number {
  if (!eligibleAt) return 0;
  const eligibleAtMs = new Date(eligibleAt).getTime();
  if (!Number.isFinite(eligibleAtMs)) return 0;
  return Math.max(0, Math.ceil((eligibleAtMs - nowMs) / 1_000));
}

export function demoActionHint(input: {
  demoMode: boolean;
  busy: boolean;
  scenarioStatus: "ACTIVE" | "RESET" | null;
  hasIncident: boolean;
  hasInvestigation: boolean;
  graceRemainingSeconds: number;
}): string {
  if (!input.demoMode) return "Enable DEMO_MODE on the API server to unlock the merchant-only scenario.";
  if (input.busy) return "Wait for the current action to finish.";
  if (input.scenarioStatus !== "ACTIVE") return "Next: simulate the merchant update failure.";
  if (!input.hasIncident && input.graceRemainingSeconds > 0) {
    return `Wait ${input.graceRemainingSeconds}s for the application grace period.`;
  }
  if (!input.hasIncident) return "Next: run deterministic reconciliation.";
  if (!input.hasInvestigation) return "Next: generate the evidence-grounded investigation.";
  return "Investigation complete. Replay locally or reset the merchant state.";
}

export function eventTitle(kind: string): string {
  return kind.split("_").map((word) => word[0] + word.slice(1).toLowerCase()).join(" ");
}

export function formatTime(value: string | null): string {
  if (!value) return "Not observed";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(new Date(value));
}
