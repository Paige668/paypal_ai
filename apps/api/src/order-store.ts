import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import type {
  MerchantOrder,
  OrderRepository,
  OrderTimeline,
  PaymentEvent,
  VerifiedWebhookEvent,
  WebhookIngestStatus
} from "./types.js";

const legacyOrderSchema = z.object({
  merchantOrderId: z.string().startsWith("ord_"),
  paypalOrderId: z.string().min(1),
  paypalCaptureId: z.string().min(1).nullable(),
  paypalOrderStatus: z.enum(["CREATED", "APPROVED", "COMPLETED", "FAILED"]),
  paypalCaptureStatus: z.string().nullable(),
  amount: z.object({
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    value: z.string().regex(/^\d{1,7}\.\d{2}$/)
  }),
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

const legacyStoreSchema = z.object({ orders: z.array(legacyOrderSchema) });

interface OrderRow {
  id: string;
  paypal_order_id: string;
  paypal_capture_id: string | null;
  paypal_order_status: MerchantOrder["paypalOrderStatus"];
  external_capture_status: string | null;
  local_status: MerchantOrder["localStatus"];
  amount_minor: number;
  currency: string;
  created_at: string;
  updated_at: string;
  capture_observed_at: string | null;
}

interface EventRow {
  id: string;
  source: PaymentEvent["source"];
  provider_event_id: string | null;
  kind: PaymentEvent["kind"];
  verification_status: PaymentEvent["verificationStatus"];
  observed_at: string;
  provider_created_at: string | null;
  summary_json: string;
}

function toMinorUnits(value: string): number {
  const [whole, fraction] = value.split(".");
  return Number(whole) * 100 + Number(fraction);
}

function fromMinorUnits(value: number): string {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

function mapEvent(row: EventRow): PaymentEvent {
  return {
    evidenceId: row.id,
    source: row.source,
    providerEventId: row.provider_event_id,
    kind: row.kind,
    verificationStatus: row.verification_status,
    observedAt: row.observed_at,
    providerCreatedAt: row.provider_created_at,
    summary: JSON.parse(row.summary_json) as Record<string, string>
  };
}

export class SqliteOrderRepository implements OrderRepository {
  private readonly database: Database.Database;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.database = new Database(filePath);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("journal_mode = WAL");
    this.initializeSchema();
  }

  async save(order: MerchantOrder): Promise<void> {
    const saveTransaction = this.database.transaction((value: MerchantOrder) => {
      this.database.prepare(`
        INSERT INTO merchant_orders (
          id, paypal_order_id, paypal_capture_id, paypal_order_status,
          external_capture_status, local_status, amount_minor, currency,
          created_at, updated_at, capture_observed_at
        ) VALUES (
          @id, @paypalOrderId, @paypalCaptureId, @paypalOrderStatus,
          @externalCaptureStatus, @localStatus, @amountMinor, @currency,
          @createdAt, @updatedAt, @captureObservedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          paypal_order_id = excluded.paypal_order_id,
          paypal_capture_id = excluded.paypal_capture_id,
          paypal_order_status = excluded.paypal_order_status,
          external_capture_status = excluded.external_capture_status,
          local_status = excluded.local_status,
          amount_minor = excluded.amount_minor,
          currency = excluded.currency,
          updated_at = excluded.updated_at,
          capture_observed_at = excluded.capture_observed_at
      `).run({
        id: value.merchantOrderId,
        paypalOrderId: value.paypalOrderId,
        paypalCaptureId: value.paypalCaptureId,
        paypalOrderStatus: value.paypalOrderStatus,
        externalCaptureStatus: value.paypalCaptureStatus,
        localStatus: value.localStatus,
        amountMinor: toMinorUnits(value.amount.value),
        currency: value.amount.currencyCode,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        captureObservedAt: value.captureObservedAt
      });

      const insertEvent = this.database.prepare(`
        INSERT INTO payment_events (
          id, source, provider_event_id, paypal_order_id, paypal_capture_id,
          merchant_order_id, kind, observed_at, provider_created_at,
          verification_status, summary_json
        ) VALUES (
          @id, @source, @providerEventId, @paypalOrderId, @paypalCaptureId,
          @merchantOrderId, @kind, @observedAt, @providerCreatedAt,
          @verificationStatus, @summaryJson
        )
        ON CONFLICT(id) DO NOTHING
      `);
      for (const event of value.evidence) {
        insertEvent.run({
          id: event.evidenceId,
          source: event.source,
          providerEventId: event.providerEventId,
          paypalOrderId: value.paypalOrderId,
          paypalCaptureId: event.summary.captureId ?? null,
          merchantOrderId: value.merchantOrderId,
          kind: event.kind,
          observedAt: event.observedAt,
          providerCreatedAt: event.providerCreatedAt,
          verificationStatus: event.verificationStatus,
          summaryJson: JSON.stringify(event.summary)
        });
      }
    });
    saveTransaction(order);
  }

  async findByMerchantOrderId(id: string): Promise<MerchantOrder | null> {
    const row = this.database.prepare("SELECT * FROM merchant_orders WHERE id = ?").get(id) as OrderRow | undefined;
    if (!row) return null;
    return this.mapOrder(row);
  }

  async getTimeline(id: string): Promise<OrderTimeline | null> {
    const order = await this.findByMerchantOrderId(id);
    if (!order) return null;
    return {
      merchantOrderId: order.merchantOrderId,
      paypalOrderId: order.paypalOrderId,
      localStatus: order.localStatus,
      externalCaptureStatus: order.paypalCaptureStatus,
      events: order.evidence
    };
  }

  async recordVerifiedWebhook(event: VerifiedWebhookEvent): Promise<WebhookIngestStatus> {
    const ingest = this.database.transaction((value: VerifiedWebhookEvent): WebhookIngestStatus => {
      const duplicate = this.database.prepare(
        "SELECT 1 FROM payment_events WHERE provider_event_id = ?"
      ).get(value.providerEventId);
      if (duplicate) return "DUPLICATE";

      const order = this.database.prepare(`
        SELECT id
        FROM merchant_orders
        WHERE paypal_order_id = @paypalOrderId
           OR paypal_capture_id = @paypalCaptureId
        LIMIT 1
      `).get({
        paypalOrderId: value.paypalOrderId,
        paypalCaptureId: value.paypalCaptureId
      }) as { id: string } | undefined;

      this.database.prepare(`
        INSERT INTO payment_events (
          id, source, provider_event_id, paypal_order_id, paypal_capture_id,
          merchant_order_id, kind, observed_at, provider_created_at,
          verification_status, summary_json
        ) VALUES (
          @id, 'PAYPAL_WEBHOOK', @providerEventId, @paypalOrderId, @paypalCaptureId,
          @merchantOrderId, @kind, @observedAt, @providerCreatedAt,
          'VERIFIED_WEBHOOK', @summaryJson
        )
      `).run({
        id: `ev_webhook_${value.providerEventId}`,
        providerEventId: value.providerEventId,
        paypalOrderId: value.paypalOrderId,
        paypalCaptureId: value.paypalCaptureId,
        merchantOrderId: order?.id ?? null,
        kind: value.eventType === "PAYMENT.CAPTURE.COMPLETED"
          ? "WEBHOOK_CAPTURE_COMPLETED"
          : "WEBHOOK_EVENT_OBSERVED",
        observedAt: value.observedAt,
        providerCreatedAt: value.providerCreatedAt,
        summaryJson: JSON.stringify(value.summary)
      });

      if (!order) return "QUARANTINED";

      if (value.eventType === "PAYMENT.CAPTURE.COMPLETED") {
        this.database.prepare(`
          UPDATE merchant_orders
          SET paypal_capture_id = COALESCE(paypal_capture_id, @paypalCaptureId),
              external_capture_status = @captureStatus,
              capture_observed_at = COALESCE(capture_observed_at, @observedAt),
              updated_at = @observedAt
          WHERE id = @merchantOrderId
        `).run({
          paypalCaptureId: value.paypalCaptureId,
          captureStatus: value.captureStatus,
          observedAt: value.observedAt,
          merchantOrderId: order.id
        });
      }
      return "PROCESSED";
    });
    return ingest(event);
  }

  async importLegacyJson(filePath: string): Promise<number> {
    const existing = this.database.prepare("SELECT COUNT(*) AS count FROM merchant_orders").get() as { count: number };
    if (existing.count > 0) return 0;

    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }

    const legacyOrders = legacyStoreSchema.parse(JSON.parse(content)).orders;
    for (const legacy of legacyOrders) {
      await this.save({
        ...legacy,
        localStatus: legacy.paypalCaptureStatus === "COMPLETED" ? "PAID" : "PENDING_PAYMENT",
        evidence: legacy.evidence.map((event) => ({
          ...event,
          source: "PAYPAL_API",
          providerEventId: null,
          verificationStatus: "API_RESPONSE",
          providerCreatedAt: null
        }))
      });
    }
    return legacyOrders.length;
  }

  close(): void {
    this.database.close();
  }

  private mapOrder(row: OrderRow): MerchantOrder {
    const events = this.database.prepare(`
      SELECT id, source, provider_event_id, kind, verification_status,
             observed_at, provider_created_at, summary_json
      FROM payment_events
      WHERE merchant_order_id = ?
      ORDER BY observed_at ASC, rowid ASC
    `).all(row.id) as EventRow[];
    return {
      merchantOrderId: row.id,
      paypalOrderId: row.paypal_order_id,
      paypalCaptureId: row.paypal_capture_id,
      paypalOrderStatus: row.paypal_order_status,
      paypalCaptureStatus: row.external_capture_status,
      localStatus: row.local_status,
      amount: { currencyCode: row.currency, value: fromMinorUnits(row.amount_minor) },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      captureObservedAt: row.capture_observed_at,
      evidence: events.map(mapEvent)
    };
  }

  private initializeSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS merchant_orders (
        id TEXT PRIMARY KEY,
        paypal_order_id TEXT NOT NULL UNIQUE,
        paypal_capture_id TEXT UNIQUE,
        paypal_order_status TEXT NOT NULL,
        external_capture_status TEXT,
        local_status TEXT NOT NULL CHECK (local_status IN ('PENDING_PAYMENT', 'PAID', 'CANCELLED')),
        amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
        currency TEXT NOT NULL CHECK (length(currency) = 3),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        capture_observed_at TEXT,
        inject_merchant_update_failure INTEGER NOT NULL DEFAULT 0 CHECK (inject_merchant_update_failure IN (0, 1))
      );

      CREATE TABLE IF NOT EXISTS payment_events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('PAYPAL_API', 'PAYPAL_WEBHOOK', 'MERCHANT', 'DEMO_INJECTION')),
        provider_event_id TEXT,
        paypal_order_id TEXT,
        paypal_capture_id TEXT,
        merchant_order_id TEXT,
        kind TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        provider_created_at TEXT,
        verification_status TEXT NOT NULL CHECK (
          verification_status IN ('API_RESPONSE', 'VERIFIED_WEBHOOK', 'MERCHANT_RECORDED', 'SIMULATED')
        ),
        summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
        FOREIGN KEY (merchant_order_id) REFERENCES merchant_orders(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS payment_events_provider_event_id_unique
        ON payment_events(provider_event_id)
        WHERE provider_event_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS payment_events_merchant_timeline
        ON payment_events(merchant_order_id, observed_at);

      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        merchant_order_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
        detected_at TEXT NOT NULL,
        capture_evidence_event_id TEXT NOT NULL,
        merchant_status_evidence_event_id TEXT NOT NULL,
        reconciliation_version TEXT NOT NULL,
        report_json TEXT,
        FOREIGN KEY (merchant_order_id) REFERENCES merchant_orders(id),
        FOREIGN KEY (capture_evidence_event_id) REFERENCES payment_events(id),
        FOREIGN KEY (merchant_status_evidence_event_id) REFERENCES payment_events(id)
      );

      PRAGMA user_version = 1;
    `);
  }
}
