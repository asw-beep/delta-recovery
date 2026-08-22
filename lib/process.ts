import { asc, isNull, sql } from "drizzle-orm";
import { attributeRecovery } from "./batch";
import { db, schema } from "./db";
import { closeSettledRisks, openRiskForFailedPayment } from "./detect";
import { upsertDowntime, upsertInvoice, upsertOrder, upsertPayment } from "./normalise";
import type { RzpDowntime, RzpInvoice, RzpOrder, RzpPayment } from "./razorpay";

/**
 * Drains the raw webhook log into normalised state.
 *
 * The receiver deliberately does no interpretation — it persists and
 * acknowledges inside Razorpay's 5s window. Everything downstream happens here,
 * driven either by `after()` on the request or by the reconciliation cron, and
 * it must be safe to run both concurrently.
 */

type EventPayload = {
  event?: string;
  payload?: {
    payment?: { entity?: RzpPayment; downtime?: { entity?: RzpDowntime } };
    order?: { entity?: RzpOrder };
    invoice?: { entity?: RzpInvoice };
    payment_link?: { entity?: Record<string, unknown> };
  };
};

export interface ProcessResult {
  processed: number;
  failed: number;
  risksOpened: number;
  selfRecovered: number;
  afterAction: number;
}

export async function processPendingEvents(limit = 50): Promise<ProcessResult> {
  const pending = await db()
    .select({
      id: schema.webhookEvents.id,
      event: schema.webhookEvents.event,
      payload: schema.webhookEvents.payload,
      signatureValid: schema.webhookEvents.signatureValid,
    })
    .from(schema.webhookEvents)
    .where(isNull(schema.webhookEvents.processedAt))
    .orderBy(asc(schema.webhookEvents.receivedAt))
    .limit(limit);

  let processed = 0;
  let failed = 0;
  let risksOpened = 0;

  for (const row of pending) {
    try {
      // Unverified deliveries are stored for the audit trail but never acted on.
      if (row.signatureValid) {
        risksOpened += await handleEvent(row.event, row.payload as EventPayload, row.id);
      }
      await db()
        .update(schema.webhookEvents)
        .set({ processedAt: new Date(), processingError: null })
        .where(sql`${schema.webhookEvents.id} = ${row.id}`);
      processed++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      // Left unprocessed on purpose so the next sweep retries it.
      await db()
        .update(schema.webhookEvents)
        .set({ processingError: message.slice(0, 500) })
        .where(sql`${schema.webhookEvents.id} = ${row.id}`);
    }
  }

  const { selfRecovered, afterAction } = await closeSettledRisks();
  return { processed, failed, risksOpened, selfRecovered, afterAction };
}

/** Returns how many risk items this event opened. */
async function handleEvent(
  event: string,
  payload: EventPayload,
  eventRowId: string,
): Promise<number> {
  const payment = payload.payload?.payment?.entity;
  const order = payload.payload?.order?.entity;
  const invoice = payload.payload?.invoice?.entity;
  const downtime = payload.payload?.payment?.downtime?.entity;

  // Orders first: payments carry a foreign key to them.
  if (order?.id) await upsertOrder(order);
  if (invoice?.id) await upsertInvoice(invoice);

  if (downtime?.id) {
    await upsertDowntime(downtime);
    return 0;
  }

  if (payment?.id) {
    await upsertPayment(payment);

    if (event === "payment.failed" && payment.status === "failed") {
      const opened = await openRiskForFailedPayment(payment.id, "webhook");
      return opened ? 1 : 0;
    }
  }

  // Recovery attribution. The link was created carrying notes.decision_id, so a
  // payment against it identifies the decision that caused it. This is where
  // "measured money recovered" actually comes from — without it the figure
  // would be a guess.
  const link = payload.payload?.payment_link?.entity as
    | { id?: string; notes?: Record<string, unknown>; amount_paid?: number; amount?: number }
    | undefined;

  if (link?.id && (event === "payment_link.paid" || event === "payment_link.partially_paid")) {
    await attributeRecovery(
      link.notes,
      Number(link.amount_paid ?? payment?.amount ?? link.amount ?? 0),
      event,
      eventRowId,
    );
  }

  if (invoice?.id && (event === "invoice.paid" || event === "invoice.partially_paid")) {
    await attributeRecovery(
      notesOf(invoice),
      Number(invoice.amount_paid ?? 0),
      event,
      eventRowId,
    );
  }

  return 0;
}

function notesOf(e: { notes?: Record<string, string> | unknown[] }): Record<string, unknown> {
  return e.notes && !Array.isArray(e.notes) ? e.notes : {};
}

/** Unprocessed backlog, for the health view. */
export async function pendingEventCount(): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.webhookEvents)
    .where(isNull(schema.webhookEvents.processedAt));
  return row?.n ?? 0;
}
