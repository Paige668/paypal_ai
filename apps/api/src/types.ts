export type OrderStatus = "CREATED" | "APPROVED" | "COMPLETED" | "FAILED";
export type MerchantLocalStatus = "PENDING_PAYMENT" | "PAID" | "CANCELLED";
export type PaymentEventSource = "PAYPAL_API" | "PAYPAL_WEBHOOK" | "MERCHANT" | "DEMO_INJECTION";
export type VerificationStatus = "API_RESPONSE" | "VERIFIED_WEBHOOK" | "MERCHANT_RECORDED" | "SIMULATED";

export interface PaymentEvent {
  evidenceId: string;
  source: PaymentEventSource;
  providerEventId: string | null;
  kind: "ORDER_CREATED" | "CAPTURE_COMPLETED" | "CAPTURE_OBSERVED" | "MERCHANT_STATUS_UPDATED";
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
  evidence: PaymentEvent[];
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

export interface PayPalGateway {
  createOrder(input: CreatePayPalOrderInput): Promise<CreatePayPalOrderResult>;
  captureOrder(paypalOrderId: string, requestId: string): Promise<CapturePayPalOrderResult>;
}

export interface OrderRepository {
  save(order: MerchantOrder): Promise<void>;
  findByMerchantOrderId(id: string): Promise<MerchantOrder | null>;
  getTimeline(id: string): Promise<OrderTimeline | null>;
}

