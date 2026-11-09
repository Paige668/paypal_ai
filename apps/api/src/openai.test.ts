import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiInvestigator } from "./openai.js";
import type { InvestigationEvidencePack } from "./types.js";

const pack: InvestigationEvidencePack = {
  incidentId: "inc_test",
  ruleId: "MISMATCH_CAPTURED_PENDING@1",
  incidentType: "PAYMENT_CAPTURED_MERCHANT_PENDING",
  detectedAt: "2026-11-06T10:00:00.000Z",
  externalCaptureStatus: "COMPLETED",
  merchantLocalStatusAtDetection: "PENDING_PAYMENT",
  merchantSuccessfulLocalStatus: "PAID",
  currentMerchantLocalStatus: "PENDING_PAYMENT",
  evidence: [{
    evidenceId: "ev_capture",
    source: "PAYPAL_API",
    verificationStatus: "API_RESPONSE",
    observedAt: "2026-11-06T09:58:00.000Z",
    factType: "CAPTURE_COMPLETED",
    sanitizedValue: { status: "COMPLETED" }
  }]
};

afterEach(() => vi.unstubAllGlobals());

describe("OpenAiInvestigator", () => {
  it("uses the Responses API with strict JSON Schema and returns parsed output", async () => {
    const report = {
      label: "AI-assisted analysis",
      summary: "Grounded.",
      facts: [{ statement: "Capture completed.", evidenceIds: ["ev_capture"] }],
      hypotheses: [],
      unknowns: [],
      nextSteps: []
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ output_text: JSON.stringify(report) })
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenAiInvestigator("test-key", "test-model", "https://api.openai.test", 5_000);

    await expect(client.investigate(pack)).resolves.toEqual(report);
    const [url, options] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(options.body as string);
    expect(url).toBe("https://api.openai.test/v1/responses");
    expect(options.headers.Authorization).toBe("Bearer test-key");
    expect(body).toMatchObject({
      model: "test-model",
      text: { format: { type: "json_schema", name: "paytrace_investigation", strict: true } }
    });
    expect(JSON.stringify(body.input)).toContain("ev_capture");
    expect(JSON.stringify(body.input)).toContain("merchant-local success is PAID");
    expect(JSON.stringify(body)).not.toContain("PAYPAL_CLIENT_SECRET");
  });

  it("fails closed when the provider response has no structured output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ output: [] }) }));
    const client = new OpenAiInvestigator("test-key", "test-model", "https://api.openai.test", 5_000);

    await expect(client.investigate(pack)).rejects.toThrow("OPENAI_RESPONSE_MISSING_OUTPUT");
  });
});
