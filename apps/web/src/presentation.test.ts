import { describe, expect, it } from "vitest";
import {
  amountValidationMessage,
  demoActionHint,
  friendlyError,
  graceSecondsRemaining,
  provenance,
  workflowStage
} from "./presentation";
import type { Order } from "./types";

const capturedOrder: Order = {
  merchantOrderId: "ord_test",
  paypalOrderId: "PAYPAL-ORDER",
  paypalCaptureId: "CAPTURE-1",
  paypalOrderStatus: "COMPLETED",
  paypalCaptureStatus: "COMPLETED",
  localStatus: "PAID",
  amount: { currencyCode: "USD", value: "10.00" },
  captureObservedAt: "2026-11-07T10:00:00.000Z",
  merchantUpdateFailureInjected: false,
  scenarioRunId: null
};

describe("investigation UI presentation", () => {
  it("keeps provider, merchant, and simulated provenance visibly distinct", () => {
    expect(provenance.PAYPAL_API.tone).not.toBe(provenance.MERCHANT.tone);
    expect(provenance.DEMO_INJECTION.label).toContain("Simulated");
    expect(provenance.PAYPAL_WEBHOOK.label).toContain("Verified");
  });

  it("advances through capture, scenario, and incident stages", () => {
    expect(workflowStage(null, false, false)).toBe(1);
    expect(workflowStage(capturedOrder, false, false)).toBe(2);
    expect(workflowStage(capturedOrder, true, false)).toBe(3);
    expect(workflowStage(capturedOrder, true, true)).toBe(4);
  });

  it("explains disabled demo controls without hiding the server setting", () => {
    expect(friendlyError("DEMO_MODE_DISABLED")).toContain("DEMO_MODE=true");
  });

  it("rejects malformed or zero-value amounts before checkout", () => {
    expect(amountValidationMessage("10.00")).toBeNull();
    expect(amountValidationMessage("10")).toContain("two decimal");
    expect(amountValidationMessage("0.00")).toContain("greater than");
    expect(amountValidationMessage("10000000.00")).toContain("two decimal");
  });

  it("turns an eligible timestamp into a stable visible grace countdown", () => {
    const now = new Date("2026-11-09T10:00:00.250Z").getTime();
    expect(graceSecondsRemaining("2026-11-09T10:00:05.000Z", now)).toBe(5);
    expect(graceSecondsRemaining("2026-11-09T10:00:00.000Z", now)).toBe(0);
    expect(graceSecondsRemaining(null, now)).toBe(0);
  });

  it("provides a visible next action through grace and investigation states", () => {
    expect(demoActionHint({
      demoMode: true,
      busy: false,
      scenarioStatus: "ACTIVE",
      hasIncident: false,
      hasInvestigation: false,
      graceRemainingSeconds: 4
    })).toContain("Wait 4s");
    expect(demoActionHint({
      demoMode: true,
      busy: false,
      scenarioStatus: "ACTIVE",
      hasIncident: true,
      hasInvestigation: false,
      graceRemainingSeconds: 0
    })).toContain("generate");
  });
});
