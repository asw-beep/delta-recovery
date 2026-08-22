import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "./db";

/**
 * Risk detection.
 *
 * A risk item is one unit of money at risk. Both the webhook path and the
 * reconciliation sweep call into here, and they must converge on exactly one
 * open item per source entity — which is guaranteed by the partial unique index
 * `risk_items_open_source_uq`, not by checking first and hoping.
 */

/**
 * Opens a risk item for a failed payment. Idempotent: a second call for the
 * same payment is absorbed by the database.
 *
 * Returns the risk item id when this call created it, else null.
 */
export async function openRiskForFailedPayment(
  razorpayPaymentId: string,
  detectedVia: "webhook" | "reconciliation",
): Promise<string | null> {
  const [p] = await db()
    .select({
      id: schema.payments.id,
      merchantId: schema.payments.merchantId,
      customerId: schema.payments.customerId,
      status: schema.payments.status,
      amountPaise: schema.payments.amountPaise,
    })
    .from(schema.payments)
    .where(eq(schema.payments.razorpayPaymentId, razorpayPaymentId))
    .limit(1);

  if (!p || p.status !== "failed") return null;

  // If this payment's order has since been paid, the money is not at risk.
  const settled = await orderAlreadyPaid(razorpayPaymentId);
  if (settled) return null;

  const [row] = await db()
    .insert(schema.riskItems)
    .values({
      merchantId: p.merchantId,
      customerId: p.customerId,
      class: "failed_payment",
      state: "open",
      sourceEntityId: razorpayPaymentId,
      sourceEntityType: "payment",
      amountAtRiskPaise: p.amountPaise,
      detectedVia,
    })
    // The partial unique index makes a concurrent second insert a no-op.
    .onConflictDoNothing()
    .returning({ id: schema.riskItems.id });

  return row?.id ?? null;
}

async function orderAlreadyPaid(razorpayPaymentId: string): Promise<boolean> {
  const rows = await db()
    .select({ status: schema.orders.status })
    .from(schema.payments)
    .innerJoin(schema.orders, eq(schema.payments.orderId, schema.orders.id))
    .where(eq(schema.payments.razorpayPaymentId, razorpayPaymentId))
    .limit(1);
  return rows[0]?.status === "paid";
}

/**
 * Closes open risk items whose money has since arrived.
 *
 * This is where self-recovery becomes observable — a customer who paid without
 * us contacting them is exactly the population the uplift model must learn to
 * leave alone, so recording it accurately matters more here than anywhere else.
 */
export async function closeSettledRisks(): Promise<{ selfRecovered: number }> {
  const settled = await db()
    .select({
      id: schema.riskItems.id,
      hasAction: sql<boolean>`exists (
        select 1 from ${schema.decisions} d
        join ${schema.actionAttempts} a on a.decision_id = d.id
        where d.risk_item_id = ${schema.riskItems.id}
          and a.status = 'succeeded'
      )`,
    })
    .from(schema.riskItems)
    .innerJoin(schema.orders, eq(schema.orders.razorpayOrderId, sql`
      (select p.razorpay_order_id from ${schema.payments} p
       where p.razorpay_payment_id = ${schema.riskItems.sourceEntityId})`))
    .where(and(eq(schema.riskItems.state, "open"), eq(schema.orders.status, "paid")));

  if (settled.length === 0) return { selfRecovered: 0 };

  // No successful action means the customer came back on their own.
  const organic = settled.filter((r) => !r.hasAction).map((r) => r.id);

  if (organic.length > 0) {
    await db()
      .update(schema.riskItems)
      .set({
        state: "recovered",
        closedAt: new Date(),
        closedReason: "self_recovered_without_intervention",
      })
      .where(inArray(schema.riskItems.id, organic));
  }

  return { selfRecovered: organic.length };
}

/** Open risk items awaiting a decision, newest first. */
export async function openRiskItems(limit = 200) {
  return db()
    .select({
      id: schema.riskItems.id,
      class: schema.riskItems.class,
      amountAtRiskPaise: schema.riskItems.amountAtRiskPaise,
      sourceEntityId: schema.riskItems.sourceEntityId,
      detectedVia: schema.riskItems.detectedVia,
      detectedAt: schema.riskItems.detectedAt,
      errorReason: schema.payments.errorReason,
      errorSource: schema.payments.errorSource,
      errorStep: schema.payments.errorStep,
      method: schema.payments.method,
      bank: schema.payments.bank,
      customerId: schema.riskItems.customerId,
    })
    .from(schema.riskItems)
    .leftJoin(
      schema.payments,
      eq(schema.payments.razorpayPaymentId, schema.riskItems.sourceEntityId),
    )
    .where(eq(schema.riskItems.state, "open"))
    .orderBy(sql`${schema.riskItems.detectedAt} desc`)
    .limit(limit);
}

/** Counts for the overview. Every dashboard number resolves to a query like this. */
export async function riskSummary() {
  const [row] = await db()
    .select({
      openCount: sql<number>`count(*) filter (where ${schema.riskItems.state} = 'open')::int`,
      openPaise: sql<number>`coalesce(sum(${schema.riskItems.amountAtRiskPaise})
                              filter (where ${schema.riskItems.state} = 'open'), 0)::bigint`,
      recoveredCount: sql<number>`count(*) filter (where ${schema.riskItems.state} = 'recovered')::int`,
      recoveredPaise: sql<number>`coalesce(sum(${schema.riskItems.amountAtRiskPaise})
                                   filter (where ${schema.riskItems.state} = 'recovered'), 0)::bigint`,
      selfRecoveredCount: sql<number>`count(*) filter (
        where ${schema.riskItems.closedReason} = 'self_recovered_without_intervention')::int`,
    })
    .from(schema.riskItems);
  return row;
}

/** Payments that failed but never produced a risk item — the reconciliation gap. */
export async function undetectedFailedPayments(limit = 100) {
  return db()
    .select({ razorpayPaymentId: schema.payments.razorpayPaymentId })
    .from(schema.payments)
    .leftJoin(
      schema.riskItems,
      eq(schema.riskItems.sourceEntityId, schema.payments.razorpayPaymentId),
    )
    .where(and(eq(schema.payments.status, "failed"), isNull(schema.riskItems.id)))
    .limit(limit);
}
