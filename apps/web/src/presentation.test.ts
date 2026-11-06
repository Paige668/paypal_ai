import { describe, expect, it } from "vitest";
import { friendlyError, provenance, workflowStage } from "./presentation";
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
});
