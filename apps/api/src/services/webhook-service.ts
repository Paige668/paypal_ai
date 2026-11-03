import { z } from "zod";
import type { OrderRepository, PayPalGateway, WebhookIngestStatus } from "../types.js";

const webhookHeadersSchema = z.object({
  transmissionId: z.string().min(1),
  transmissionTime: z.string().min(1),
  certUrl: z.string().url(),
  authAlgo: z.string().min(1),
  transmissionSignature: z.string().min(1)
});

const webhookEventSchema = z.object({
  id: z.string().min(1),
  event_type: z.string().min(1),
  create_time: z.string().optional(),
  resource: z.object({
    id: z.string().optional(),
    status: z.string().optional(),
    amount: z.object({
      currency_code: z.string().optional(),
      value: z.string().optional()
    }).optional(),
    supplementary_data: z.object({
      related_ids: z.object({ order_id: z.string().optional() }).optional()
    }).optional()
  }).passthrough()
}).passthrough();

export class WebhookServiceError extends Error {
  constructor(
    readonly code: "PAYPAL_WEBHOOK_NOT_CONFIGURED" | "INVALID_WEBHOOK_BODY" | "INVALID_WEBHOOK_SIGNATURE",
    readonly status: number
  ) {
    super(code);
    this.name = "WebhookServiceError";
  }
}

export class WebhookService {
  constructor(
    private readonly paypal: PayPalGateway,
    private readonly orders: OrderRepository,
    private readonly webhookId: string | undefined,
    private readonly now: () => Date
  ) {}

  async process(rawBody: Buffer, inputHeaders: Record<string, string | undefined>): Promise<WebhookIngestStatus> {
    if (!this.webhookId) {
      throw new WebhookServiceError("PAYPAL_WEBHOOK_NOT_CONFIGURED", 503);
    }
    const headers = webhookHeadersSchema.parse({
      transmissionId: inputHeaders["paypal-transmission-id"],
      transmissionTime: inputHeaders["paypal-transmission-time"],
      certUrl: inputHeaders["paypal-cert-url"],
      authAlgo: inputHeaders["paypal-auth-algo"],
      transmissionSignature: inputHeaders["paypal-transmission-sig"]
    });

    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new WebhookServiceError("INVALID_WEBHOOK_BODY", 400);
    }
    const event = webhookEventSchema.parse(json);
    const verified = await this.paypal.verifyWebhookSignature({
      webhookId: this.webhookId,
      ...headers,
      event: event as Record<string, unknown>
    });
    if (!verified) {
      throw new WebhookServiceError("INVALID_WEBHOOK_SIGNATURE", 400);
    }

    const paypalOrderId = event.resource.supplementary_data?.related_ids?.order_id ?? null;
    const paypalCaptureId = event.event_type.startsWith("PAYMENT.CAPTURE.")
      ? event.resource.id ?? null
      : null;
    const summary = Object.fromEntries(Object.entries({
      eventType: event.event_type,
      paypalOrderId,
      captureId: paypalCaptureId,
      status: event.resource.status,
      currencyCode: event.resource.amount?.currency_code,
      value: event.resource.amount?.value
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));

    return this.orders.recordVerifiedWebhook({
      providerEventId: event.id,
      eventType: event.event_type,
      paypalOrderId,
      paypalCaptureId,
      captureStatus: event.resource.status ?? null,
      observedAt: this.now().toISOString(),
      providerCreatedAt: event.create_time ?? null,
      summary
    });
  }
}
