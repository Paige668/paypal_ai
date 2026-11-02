import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonOrderRepository } from "./order-store.js";
import type { MerchantOrder } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("JsonOrderRepository", () => {
  it("persists an allowlisted order across repository instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paytrace-orders-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "orders.json");
    const order: MerchantOrder = {
      merchantOrderId: "ord_test",
      paypalOrderId: "PAYPAL-1",
      paypalCaptureId: null,
      paypalOrderStatus: "CREATED",
      paypalCaptureStatus: null,
      amount: { currencyCode: "USD", value: "10.00" },
      createdAt: "2026-11-01T10:00:00.000Z",
      updatedAt: "2026-11-01T10:00:00.000Z",
      captureObservedAt: null,
      evidence: [{
        evidenceId: "ev_test",
        source: "PAYPAL_API_CONFIRMED",
        kind: "ORDER_CREATED",
        observedAt: "2026-11-01T10:00:00.000Z",
        summary: { paypalOrderId: "PAYPAL-1", status: "CREATED" }
      }]
    };

    await new JsonOrderRepository(path).save(order);
    const reloaded = await new JsonOrderRepository(path).findByMerchantOrderId("ord_test");
    expect(reloaded).toEqual(order);
  });
});

