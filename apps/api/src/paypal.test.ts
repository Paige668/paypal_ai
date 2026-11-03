import { describe, expect, it, vi } from "vitest";
import { PayPalClient } from "./paypal.js";

describe("PayPalClient webhook verification", () => {
  it("posts the registered webhook ID, delivery headers, and event to PayPal", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "TOKEN", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ verification_status: "SUCCESS" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    const client = new PayPalClient({
      clientId: "CLIENT-ID",
      clientSecret: "CLIENT-SECRET",
      baseUrl: "https://api-m.sandbox.paypal.com",
      fetchImpl
    });
    const event = { id: "WH-EVENT-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} };

    await expect(client.verifyWebhookSignature({
      webhookId: "WH-REGISTERED-1",
      transmissionId: "TRANSMISSION-1",
      transmissionTime: "2026-11-03T10:00:00Z",
      certUrl: "https://api-m.sandbox.paypal.com/certs/test",
      authAlgo: "SHA256withRSA",
      transmissionSignature: "signature",
      event
    })).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      "https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature"
    );
    const request = fetchImpl.mock.calls[1]?.[1];
    expect(request?.method).toBe("POST");
    expect(JSON.parse(String(request?.body))).toEqual({
      auth_algo: "SHA256withRSA",
      cert_url: "https://api-m.sandbox.paypal.com/certs/test",
      transmission_id: "TRANSMISSION-1",
      transmission_sig: "signature",
      transmission_time: "2026-11-03T10:00:00Z",
      webhook_id: "WH-REGISTERED-1",
      webhook_event: event
    });
  });
});
