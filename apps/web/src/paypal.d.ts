interface Window {
  paypal?: {
    Buttons(options: {
      createOrder(): Promise<string>;
      onApprove(data: { orderID: string }): Promise<void>;
      onCancel(): void;
      onError(error: unknown): void;
    }): { render(selector: string): Promise<void>; close(): Promise<void> };
  };
}

