import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { MerchantOrder, OrderRepository } from "./types.js";

const merchantOrderSchema = z.object({
  merchantOrderId: z.string().startsWith("ord_"),
  paypalOrderId: z.string().min(1),
  paypalCaptureId: z.string().min(1).nullable(),
  paypalOrderStatus: z.enum(["CREATED", "APPROVED", "COMPLETED", "FAILED"]),
  paypalCaptureStatus: z.string().nullable(),
  amount: z.object({ currencyCode: z.string().regex(/^[A-Z]{3}$/), value: z.string().regex(/^\d{1,7}\.\d{2}$/) }),
  createdAt: z.string(),
  updatedAt: z.string(),
  captureObservedAt: z.string().nullable(),
  evidence: z.array(z.object({
    evidenceId: z.string().startsWith("ev_"),
    source: z.literal("PAYPAL_API_CONFIRMED"),
    kind: z.enum(["ORDER_CREATED", "CAPTURE_COMPLETED", "CAPTURE_OBSERVED"]),
    observedAt: z.string(),
    summary: z.record(z.string(), z.string())
  }))
});

const storeSchema = z.object({ orders: z.array(merchantOrderSchema) });

export class JsonOrderRepository implements OrderRepository {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async save(order: MerchantOrder): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const orders = await this.readAll();
      const index = orders.findIndex((candidate) => candidate.merchantOrderId === order.merchantOrderId);
      if (index >= 0) orders[index] = order;
      else orders.push(order);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, JSON.stringify({ orders }, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
  }

  async findByMerchantOrderId(id: string): Promise<MerchantOrder | null> {
    await this.writeQueue;
    return (await this.readAll()).find((order) => order.merchantOrderId === id) ?? null;
  }

  private async readAll(): Promise<MerchantOrder[]> {
    try {
      const content = await readFile(this.filePath, "utf8");
      return storeSchema.parse(JSON.parse(content)).orders;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

