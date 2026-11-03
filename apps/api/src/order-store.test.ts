import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteOrderRepository } from "./order-store.js";
import type { MerchantOrder } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function capturedOrder(localStatus: MerchantOrder["localStatus"] = "PAID"): MerchantOrder {
  return {
    merchantOrderId: "ord_test",
    paypalOrderId: "PAYPAL-1",
    paypalCaptureId: "CAPTURE-1",
    paypalOrderStatus: "COMPLETED",
    paypalCaptureStatus: "COMPLETED",
    localStatus,
    amount: { currencyCode: "USD", value: "10.00" },
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:01:00.000Z",
    captureObservedAt: "2026-11-01T10:01:00.000Z",
    evidence: [
      {
        evidenceId: "ev_capture",
        source: "PAYPAL_API",
        providerEventId: null,
        kind: "CAPTURE_COMPLETED",
        verificationStatus: "API_RESPONSE",
        observedAt: "2026-11-01T10:01:00.000Z",
        providerCreatedAt: null,
        summary: { captureId: "CAPTURE-1", status: "COMPLETED" }
      },
      {
        evidenceId: "ev_merchant",
        source: "MERCHANT",
        providerEventId: null,
        kind: "MERCHANT_STATUS_UPDATED",
        verificationStatus: "MERCHANT_RECORDED",
        observedAt: "2026-11-01T10:01:00.000Z",
        providerCreatedAt: null,
        summary: { localStatus }
      }
    ]
  };
}

describe("SqliteOrderRepository", () => {
  it("persists an order and timeline across repository instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paytrace-orders-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "orders.sqlite");
    const order = capturedOrder();

    const first = new SqliteOrderRepository(path);
    await first.save(order);
    first.close();

    const second = new SqliteOrderRepository(path);
    const reloaded = await second.findByMerchantOrderId("ord_test");
    const timeline = await second.getTimeline("ord_test");
    second.close();

    expect(reloaded).toEqual(order);
    expect(timeline).toMatchObject({
      merchantOrderId: "ord_test",
      externalCaptureStatus: "COMPLETED",
      localStatus: "PAID"
    });
    expect(timeline?.events).toEqual(order.evidence);
  });

  it("keeps external capture status independent from merchant-local status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paytrace-orders-"));
    temporaryDirectories.push(directory);
    const repository = new SqliteOrderRepository(join(directory, "orders.sqlite"));

    await repository.save(capturedOrder("PENDING_PAYMENT"));
    const reloaded = await repository.findByMerchantOrderId("ord_test");
    repository.close();

    expect(reloaded).toMatchObject({
      paypalCaptureStatus: "COMPLETED",
      localStatus: "PENDING_PAYMENT"
    });
  });

  it("enforces uniqueness for non-null provider event IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paytrace-orders-"));
    temporaryDirectories.push(directory);
    const repository = new SqliteOrderRepository(join(directory, "orders.sqlite"));
    const original = capturedOrder();
    original.evidence[0]!.providerEventId = "WH-EVENT-1";
    await repository.save(original);

    const duplicate = structuredClone(original);
    duplicate.evidence.push({
      ...duplicate.evidence[0]!,
      evidenceId: "ev_duplicate_provider_id"
    });
    await expect(repository.save(duplicate)).rejects.toThrow(/UNIQUE constraint failed/);
    repository.close();
  });

  it("records a verified webhook transactionally and deduplicates its provider event ID", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paytrace-orders-"));
    temporaryDirectories.push(directory);
    const repository = new SqliteOrderRepository(join(directory, "orders.sqlite"));
    await repository.save(capturedOrder("PENDING_PAYMENT"));
    const event = {
      providerEventId: "WH-EVENT-1",
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      paypalOrderId: "PAYPAL-1",
      paypalCaptureId: "CAPTURE-1",
      captureStatus: "COMPLETED",
      observedAt: "2026-11-03T10:00:00.000Z",
      providerCreatedAt: "2026-11-03T09:59:59.000Z",
      summary: { eventType: "PAYMENT.CAPTURE.COMPLETED", captureId: "CAPTURE-1" }
    };

    expect(await repository.recordVerifiedWebhook(event)).toBe("PROCESSED");
    expect(await repository.recordVerifiedWebhook(event)).toBe("DUPLICATE");
    expect(await repository.recordVerifiedWebhook({
      ...event,
      providerEventId: "WH-EVENT-UNKNOWN",
      paypalOrderId: "PAYPAL-UNKNOWN",
      paypalCaptureId: "CAPTURE-UNKNOWN"
    })).toBe("QUARANTINED");
    const timeline = await repository.getTimeline("ord_test");
    repository.close();

    expect(timeline?.localStatus).toBe("PENDING_PAYMENT");
    expect(timeline?.externalCaptureStatus).toBe("COMPLETED");
    expect(timeline?.events.filter((item) => item.providerEventId === "WH-EVENT-1")).toHaveLength(1);
  });

  it("imports the legacy JSON store once without changing allowlisted evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paytrace-orders-"));
    temporaryDirectories.push(directory);
    const legacyPath = join(directory, "orders.json");
    const databasePath = join(directory, "orders.sqlite");
    const legacy = capturedOrder();
    const { localStatus: _localStatus, ...legacyWithoutLocalStatus } = legacy;
    const legacyOrder = {
      ...legacyWithoutLocalStatus,
      evidence: legacy.evidence.slice(0, 1).map(({ providerEventId, providerCreatedAt, verificationStatus, ...event }) => ({
        ...event,
        source: "PAYPAL_API_CONFIRMED"
      }))
    };
    await writeFile(legacyPath, JSON.stringify({ orders: [legacyOrder] }), "utf8");

    const repository = new SqliteOrderRepository(databasePath);
    expect(await repository.importLegacyJson(legacyPath)).toBe(1);
    expect(await repository.importLegacyJson(legacyPath)).toBe(0);
    const imported = await repository.findByMerchantOrderId("ord_test");
    repository.close();

    expect(imported).toMatchObject({
      paypalCaptureStatus: "COMPLETED",
      localStatus: "PAID"
    });
    expect(imported?.evidence[0]).toMatchObject({
      source: "PAYPAL_API",
      verificationStatus: "API_RESPONSE",
      summary: { captureId: "CAPTURE-1", status: "COMPLETED" }
    });
  });
});
