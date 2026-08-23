import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db, schema } from "./db";

/**
 * Risk detection across all three sources Track 03 names: payment failures,
 * checkout abandonment, and overdue receivables.
 *
 * A risk item is one unit of money at risk. Both the webhook path and the
 * reconciliation sweep call into here, and they must converge on exactly one
 * open item per source entity — guaranteed by the partial unique index
 * `risk_items_open_source_uq`, not by checking first and hoping.
 */

/**
 * How long an unpaid order must sit before we call it abandoned.
 *
 * This matters more than it looks: contacting someone who is still mid-checkout
 * is the abandonment equivalent of a wasted contact, and abandonment is inferred
 * rather than evented (Razorpay has no `checkout.abandoned` webhook), so the
 * threshold is the whole of our precision.
 */
export const ABANDON_DWELL_HOURS = 2;

/** Grace period after issue when an invoice carries no explicit `expire_by`. */
export const RECEIVABLE_GRACE_DAYS = 15;

type Via = "webhook" | "reconciliation";

// ─── Openers ────────────────────────────────────────────────────────────────

/** Returns the new risk item id, or null when there was nothing to open. */
export async function openRiskForFailedPayment(
  razorpayPaymentId: string,
  detectedVia: Via,
): Promise<string | null> {
  const [p] = await db()
    .select({
      merchantId: schema.payments.merchantId,
      customerId: schema.payments.customerId,
      status: schema.payments.status,
      amountPaise: schema.payments.amountPaise,
      notes: schema.payments.notes,
    })
    .from(schema.payments)
    .where(eq(schema.payments.razorpayPaymentId, razorpayPaymentId))
    .limit(1);

  if (!p || p.status !== "failed") return null;
  if (await orderAlreadyPaid(razorpayPaymentId)) return null;
  if (await alreadyResolved(razorpayPaymentId)) return null;

  return insertRisk({
    merchantId: p.merchantId,
    customerId: p.customerId,
    cls: "failed_payment",
    sourceEntityId: razorpayPaymentId,
    sourceEntityType: "payment",
    amountPaise: p.amountPaise,
    detectedVia,
    // A failure on one of our own recovery links carries the risk item it came
    // from. Recording it keeps the chain walkable, so the per-item action cap
    // counts the whole pursuit rather than resetting on every new failure.
    parentRiskItemId: parentFromNotes(p.notes),
  });
}

/**
 * An order that was created or attempted, still owes money, and has sat past the
 * dwell threshold without a successful payment.
 */
export async function openRiskForAbandonedCheckout(
  razorpayOrderId: string,
  detectedVia: Via,
): Promise<string | null> {
  const [o] = await db()
    .select({
      merchantId: schema.orders.merchantId,
      customerId: schema.orders.customerId,
      status: schema.orders.status,
      amountDuePaise: schema.orders.amountDuePaise,
      createdAtRzp: schema.orders.createdAtRzp,
    })
    .from(schema.orders)
    .where(eq(schema.orders.razorpayOrderId, razorpayOrderId))
    .limit(1);

  if (!o) return null;
  if (o.status === "paid" || o.amountDuePaise <= 0) return null;

  const ageMs = Date.now() - (o.createdAtRzp?.getTime() ?? Date.now());
  if (ageMs < ABANDON_DWELL_HOURS * 3600_000) return null;

  // A captured payment means the money arrived even if the order lags.
  const [captured] = await db()
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.razorpayOrderId, razorpayOrderId),
        inArray(schema.payments.status, ["captured", "authorized"]),
      ),
    )
    .limit(1);
  if (captured) return null;
  if (await alreadyResolved(razorpayOrderId)) return null;

  return insertRisk({
    merchantId: o.merchantId,
    customerId: o.customerId,
    cls: "abandoned_checkout",
    sourceEntityId: razorpayOrderId,
    sourceEntityType: "order",
    amountPaise: o.amountDuePaise,
    detectedVia,
  });
}

/** An issued or part-paid invoice that is past due and still owes money. */
export async function openRiskForOverdueInvoice(
  razorpayInvoiceId: string,
  detectedVia: Via,
): Promise<string | null> {
  const [inv] = await db()
    .select({
      merchantId: schema.invoices.merchantId,
      customerId: schema.invoices.customerId,
      status: schema.invoices.status,
      amountDuePaise: schema.invoices.amountDuePaise,
      expireBy: schema.invoices.expireBy,
      issuedAt: schema.invoices.issuedAt,
    })
    .from(schema.invoices)
    .where(eq(schema.invoices.razorpayInvoiceId, razorpayInvoiceId))
    .limit(1);

  if (!inv) return null;
  // Razorpay only accepts notify_by for these two states (DECISIONS.md §3), so
  // anything else is unactionable and must not enter the queue.
  if (!["issued", "partially_paid"].includes(inv.status)) return null;
  if (inv.amountDuePaise <= 0) return null;

  const due =
    inv.expireBy ??
    (inv.issuedAt
      ? new Date(inv.issuedAt.getTime() + RECEIVABLE_GRACE_DAYS * 86400_000)
      : null);
  if (!due || due.getTime() > Date.now()) return null;
  if (await alreadyResolved(razorpayInvoiceId)) return null;

  return insertRisk({
    merchantId: inv.merchantId,
    customerId: inv.customerId,
    cls: "overdue_receivable",
    sourceEntityId: razorpayInvoiceId,
    sourceEntityType: "invoice",
    amountPaise: inv.amountDuePaise,
    detectedVia,
  });
}

async function insertRisk(a: {
  merchantId: string;
  customerId: string | null;
  cls: "failed_payment" | "abandoned_checkout" | "overdue_receivable";
  sourceEntityId: string;
  sourceEntityType: string;
  amountPaise: number;
  detectedVia: Via;
  parentRiskItemId?: string | null;
}): Promise<string | null> {
  const [row] = await db()
    .insert(schema.riskItems)
    .values({
      merchantId: a.merchantId,
      customerId: a.customerId,
      class: a.cls,
      state: "open",
      sourceEntityId: a.sourceEntityId,
      sourceEntityType: a.sourceEntityType,
      amountAtRiskPaise: a.amountPaise,
      detectedVia: a.detectedVia,
      parentRiskItemId: a.parentRiskItemId ?? null,
    })
    // The partial unique index makes a concurrent second insert a no-op.
    .onConflictDoNothing()
    .returning({ id: schema.riskItems.id });
  return row?.id ?? null;
}

/** Our own links carry `notes.risk_item_id`; anything else is organic traffic. */
function parentFromNotes(notes: unknown): string | null {
  if (!notes || typeof notes !== "object") return null;
  const v = (notes as Record<string, unknown>).risk_item_id;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Every risk item in this pursuit, from the given item back to the original
 * failure. Bounded so a cycle introduced by bad data cannot spin forever.
 */
export async function riskItemChain(riskItemId: string, max = 10): Promise<string[]> {
  const chain = [riskItemId];
  let current = riskItemId;

  for (let i = 0; i < max; i++) {
    const [row] = await db()
      .select({ parent: schema.riskItems.parentRiskItemId })
      .from(schema.riskItems)
      .where(eq(schema.riskItems.id, current));
    if (!row?.parent || chain.includes(row.parent)) break;
    chain.push(row.parent);
    current = row.parent;
  }
  return chain;
}

/**
 * Did the money for this payment's order already arrive?
 *
 * Joins on the Razorpay order id rather than the internal foreign key. The FK is
 * null whenever a payment was ingested before its order, which is the normal
 * case for `payment.failed` — so the FK-only version silently answered "no" and
 * let reconciliation re-open cases that had already been settled.
 */
async function orderAlreadyPaid(razorpayPaymentId: string): Promise<boolean> {
  const rows = await db()
    .select({ status: schema.orders.status })
    .from(schema.payments)
    .innerJoin(
      schema.orders,
      eq(schema.orders.razorpayOrderId, schema.payments.razorpayOrderId),
    )
    .where(eq(schema.payments.razorpayPaymentId, razorpayPaymentId))
    .limit(1);
  return rows[0]?.status === "paid";
}

/**
 * Has this entity already been through the loop and been resolved?
 *
 * The partial unique index only forbids two OPEN items for one entity, which is
 * the right constraint for the webhook and reconciliation paths racing. It does
 * not stop reconciliation re-opening something that was closed as recovered —
 * and re-opening a settled case is exactly the "chase money that already
 * arrived" behaviour the product promises not to do.
 */
async function alreadyResolved(sourceEntityId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: schema.riskItems.id })
    .from(schema.riskItems)
    .where(
      and(
        eq(schema.riskItems.sourceEntityId, sourceEntityId),
        inArray(schema.riskItems.state, ["recovered", "closed"]),
      ),
    )
    .limit(1);
  return Boolean(row);
}

// ─── Bulk sweeps, used by reconciliation ────────────────────────────────────

export async function sweepAbandonedCheckouts(limit = 200): Promise<number> {
  const cutoff = new Date(Date.now() - ABANDON_DWELL_HOURS * 3600_000);
  const candidates = await db()
    .select({ id: schema.orders.razorpayOrderId })
    .from(schema.orders)
    .leftJoin(
      schema.riskItems,
      eq(schema.riskItems.sourceEntityId, schema.orders.razorpayOrderId),
    )
    .where(
      and(
        inArray(schema.orders.status, ["created", "attempted"]),
        sql`${schema.orders.amountDuePaise} > 0`,
        // lt(), not a raw sql template: interpolating a JS Date into sql``
        // binds it unmapped, and postgres-js then throws
        // "The string argument must be of type string ... Received an instance
        // of Date". The typed operator applies the column's timestamp mapper.
        lt(schema.orders.createdAtRzp, cutoff),
        isNull(schema.riskItems.id),
      ),
    )
    .limit(limit);

  let opened = 0;
  for (const c of candidates) {
    if (await openRiskForAbandonedCheckout(c.id, "reconciliation")) opened++;
  }
  return opened;
}

export async function sweepOverdueInvoices(limit = 200): Promise<number> {
  const candidates = await db()
    .select({ id: schema.invoices.razorpayInvoiceId })
    .from(schema.invoices)
    .leftJoin(
      schema.riskItems,
      eq(schema.riskItems.sourceEntityId, schema.invoices.razorpayInvoiceId),
    )
    .where(
      and(
        inArray(schema.invoices.status, ["issued", "partially_paid"]),
        sql`${schema.invoices.amountDuePaise} > 0`,
        isNull(schema.riskItems.id),
      ),
    )
    .limit(limit);

  let opened = 0;
  for (const c of candidates) {
    if (await openRiskForOverdueInvoice(c.id, "reconciliation")) opened++;
  }
  return opened;
}

// ─── Settling ───────────────────────────────────────────────────────────────

/**
 * Closes open risk items whose money has since arrived, for every class.
 *
 * This is where self-recovery becomes observable — a customer who paid without
 * us contacting them is exactly the population the model must learn to leave
 * alone. The do-nothing floor in the evaluation is built from these rows, so
 * getting the attribution right here matters more than anywhere else.
 */
export async function closeSettledRisks(): Promise<{
  selfRecovered: number;
  afterAction: number;
}> {
  const settled = await db().execute<{ id: string; has_action: boolean }>(sql`
    -- failed payments: settled when the order is paid or the payment captured
    select ri.id, ${HAS_ACTION} as has_action
    from risk_items ri
    join payments p on p.razorpay_payment_id = ri.source_entity_id
    left join orders o on o.razorpay_order_id = p.razorpay_order_id
    where ri.state = 'open' and ri.class = 'failed_payment'
      and (o.status = 'paid' or p.status in ('captured', 'authorized'))

    union all

    -- abandoned checkout: settled when the order is paid
    select ri.id, ${HAS_ACTION} as has_action
    from risk_items ri
    join orders o on o.razorpay_order_id = ri.source_entity_id
    where ri.state = 'open' and ri.class = 'abandoned_checkout'
      and o.status = 'paid'

    union all

    -- receivables: settled when the invoice is paid
    select ri.id, ${HAS_ACTION} as has_action
    from risk_items ri
    join invoices i on i.razorpay_invoice_id = ri.source_entity_id
    where ri.state = 'open' and ri.class = 'overdue_receivable'
      and i.status = 'paid'
  `);

  const rows = Array.from(settled) as Array<{ id: string; has_action: boolean }>;
  if (rows.length === 0) return { selfRecovered: 0, afterAction: 0 };

  const organic = rows.filter((r) => !r.has_action).map((r) => r.id);
  const assisted = rows.filter((r) => r.has_action).map((r) => r.id);

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
  if (assisted.length > 0) {
    await db()
      .update(schema.riskItems)
      .set({
        state: "recovered",
        closedAt: new Date(),
        closedReason: "recovered_after_intervention",
      })
      .where(inArray(schema.riskItems.id, assisted));
  }

  return { selfRecovered: organic.length, afterAction: assisted.length };
}

/** Did any action against this risk item actually execute? */
const HAS_ACTION = sql`exists (
  select 1 from decisions d
  join action_attempts a on a.decision_id = d.id
  where d.risk_item_id = ri.id and a.status = 'succeeded'
)`;

// ─── Queries for the dashboard ──────────────────────────────────────────────

export async function openRiskItems(limit = 300) {
  return db()
    .select({
      id: schema.riskItems.id,
      class: schema.riskItems.class,
      amountAtRiskPaise: schema.riskItems.amountAtRiskPaise,
      sourceEntityId: schema.riskItems.sourceEntityId,
      sourceEntityType: schema.riskItems.sourceEntityType,
      detectedVia: schema.riskItems.detectedVia,
      detectedAt: schema.riskItems.detectedAt,
      customerId: schema.riskItems.customerId,
      // Present only for failed payments; null for the other two classes.
      errorReason: schema.payments.errorReason,
      errorSource: schema.payments.errorSource,
      errorStep: schema.payments.errorStep,
      method: schema.payments.method,
      bank: schema.payments.bank,
    })
    .from(schema.riskItems)
    .leftJoin(
      schema.payments,
      eq(schema.payments.razorpayPaymentId, schema.riskItems.sourceEntityId),
    )
    .where(eq(schema.riskItems.state, "open"))
    .orderBy(sql`${schema.riskItems.amountAtRiskPaise} desc`)
    .limit(limit);
}

/** Overview totals, split by class. Every dashboard number resolves to this. */
export async function riskSummary() {
  const byClass = await db()
    .select({
      class: schema.riskItems.class,
      openCount: sql<number>`count(*) filter (where ${schema.riskItems.state} = 'open')::int`,
      openPaise: sql<number>`coalesce(sum(${schema.riskItems.amountAtRiskPaise})
                              filter (where ${schema.riskItems.state} = 'open'), 0)::bigint`,
      recoveredCount: sql<number>`count(*) filter (where ${schema.riskItems.state} = 'recovered')::int`,
      recoveredPaise: sql<number>`coalesce(sum(${schema.riskItems.amountAtRiskPaise})
                                   filter (where ${schema.riskItems.state} = 'recovered'), 0)::bigint`,
      selfRecovered: sql<number>`count(*) filter (
        where ${schema.riskItems.closedReason} = 'self_recovered_without_intervention')::int`,
      afterAction: sql<number>`count(*) filter (
        where ${schema.riskItems.closedReason} = 'recovered_after_intervention')::int`,
    })
    .from(schema.riskItems)
    .groupBy(schema.riskItems.class);

  return byClass;
}

/** Failed payments with no risk item — the gap reconciliation exists to close. */
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
