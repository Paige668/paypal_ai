export type OrderStatus = "CREATED" | "APPROVED" | "COMPLETED" | "FAILED";

export interface MerchantOrder {
  merchantOrderId: string;
  paypalOrderId: string;
  paypalCaptureId: string | null;
  paypalOrderStatus: OrderStatus;
  paypalCaptureStatus: string | null;
  amount: { currencyCode: string; value: string };
  createdAt: string;
  updatedAt: string;
  captureObservedAt: string | null;
  evidence: Array<{
    evidenceId: string;
    source: "PAYPAL_API_CONFIRMED";
    kind: "ORDER_CREATED" | "CAPTURE_COMPLETED" | "CAPTURE_OBSERVED";
    observedAt: string;
    summary: Record<string, string>;
  }>;
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
}

