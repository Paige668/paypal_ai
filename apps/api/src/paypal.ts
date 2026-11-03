import { z } from "zod";
import type {
  CapturePayPalOrderResult,
  CreatePayPalOrderInput,
  CreatePayPalOrderResult,
  PayPalGateway,
  VerifyPayPalWebhookInput
} from "./types.js";

const tokenSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().positive()
});

const createOrderSchema = z.object({
  id: z.string(),
  status: z.string()
});

const captureOrderSchema = z.object({
  id: z.string(),
  status: z.string(),
  purchase_units: z.array(
    z.object({
      payments: z.object({
        captures: z.array(
          z.object({
            id: z.string(),
            status: z.string(),
            amount: z.object({
              currency_code: z.string(),
              value: z.string()
            })
          })
        ).min(1)
      })
    })
  ).min(1)
});

const webhookVerificationSchema = z.object({
  verification_status: z.enum(["SUCCESS", "FAILURE"])
});

export class PayPalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly debugId: string | null
  ) {
    super(message);
    this.name = "PayPalApiError";
  }
}

export class PayPalClient implements PayPalGateway {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly options: {
      clientId: string;
      clientSecret: string;
      baseUrl: string;
      fetchImpl?: typeof fetch;
    }
  ) {}

  async createOrder(input: CreatePayPalOrderInput): Promise<CreatePayPalOrderResult> {
    const response = await this.paypalFetch("/v2/checkout/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PayPal-Request-Id": input.requestId
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: input.merchantOrderId,
            custom_id: input.merchantOrderId,
            amount: {
              currency_code: input.currencyCode,
              value: input.value
            }
          }
        ]
      })
    });
    return createOrderSchema.parse(response);
  }

  async captureOrder(paypalOrderId: string, requestId: string): Promise<CapturePayPalOrderResult> {
    const response = captureOrderSchema.parse(
      await this.paypalFetch(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PayPal-Request-Id": requestId
        }
      })
    );
    const capture = response.purchase_units[0]?.payments.captures[0];
    if (!capture) throw new Error("PayPal capture response did not contain a capture");
    return {
      orderId: response.id,
      orderStatus: response.status,
      captureId: capture.id,
      captureStatus: capture.status,
      currencyCode: capture.amount.currency_code,
      value: capture.amount.value
    };
  }

  async verifyWebhookSignature(input: VerifyPayPalWebhookInput): Promise<boolean> {
    const response = webhookVerificationSchema.parse(
      await this.paypalFetch("/v1/notifications/verify-webhook-signature", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          auth_algo: input.authAlgo,
          cert_url: input.certUrl,
          transmission_id: input.transmissionId,
          transmission_sig: input.transmissionSignature,
          transmission_time: input.transmissionTime,
          webhook_id: input.webhookId,
          webhook_event: input.event
        })
      })
    );
    return response.verification_status === "SUCCESS";
  }

  private async paypalFetch(path: string, init: RequestInit): Promise<unknown> {
    const accessToken = await this.getAccessToken();
    const response = await this.fetcher(`${this.options.baseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${accessToken}` }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const safe = z.object({ message: z.string().optional(), debug_id: z.string().optional() }).parse(body);
      throw new PayPalApiError(safe.message ?? "PayPal request failed", response.status, safe.debug_id ?? null);
    }
    return body;
  }

  private async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString("base64");
    const response = await this.fetcher(`${this.options.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const safe = z.object({ error_description: z.string().optional() }).parse(body);
      throw new PayPalApiError(safe.error_description ?? "PayPal OAuth failed", response.status, null);
    }
    const parsed = tokenSchema.parse(body);
    this.token = { value: parsed.access_token, expiresAt: Date.now() + parsed.expires_in * 1000 };
    return parsed.access_token;
  }

  private get fetcher(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }
}

