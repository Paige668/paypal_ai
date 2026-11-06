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
    ORDER_NOT_FOUND: "The selected merchant order no longer exists.",
    SCENARIO_NOT_FOUND: "The selected scenario no longer exists."
  };
  return messages[code] ?? code.replaceAll("_", " ").toLowerCase();
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
