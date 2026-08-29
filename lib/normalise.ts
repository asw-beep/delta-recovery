import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { env } from "./env";
import {
  notesToObject,
  tsToDate,
  type RzpDowntime,
  type RzpInvoice,
  type RzpOrder,
  type RzpPayment,
} from "./razorpay";

/**
 * Turns raw Razorpay entities into our normalised tables.
 *
 * Razorpay guarantees neither ordering nor exactly-once delivery of webhooks
 * (DECISIONS.md §3), so everything here is written to be safe under both. The
 * rule: state only ever moves forward. A late-arriving `payment.authorized`
 * must never clobber a stored `captured`.
 */

/** Payment lifecycle rank. A lower-ranked update is stale and gets dropped. */
const PAYMENT_RANK: Record<string, number> = {
  created: 0,
  failed: 1,
  authorized: 2,
  captured: 3,
  refunded: 4,
};

/** Order lifecycle rank. Same rule. */
const ORDER_RANK: Record<string, number> = { created: 0, attempted: 1, paid: 2 };

export function paymentRank(status: string): number {
  return PAYMENT_RANK[status] ?? -1;
}

export function orderRank(status: string): number {
  return ORDER_RANK[status] ?? -1;
}

/** The single merchant this deployment serves. Created on first use. */
export async function merchantId(): Promise<string> {
  const keyId = env().RAZORPAY_KEY_ID;
  const d = db();
  const existing = await d
    .select({ id: schema.merchants.id })
    .from(schema.merchants)
    .where(eq(schema.merchants.razorpayKeyId, keyId))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const [created] = await d
    .insert(schema.merchants)
    .values({ name: "Delta Demo Merchant", razorpayKeyId: keyId })
    .onConflictDoNothing()
    .returning({ id: schema.merchants.id });
  if (created) return created.id;

  const again = await d
    .select({ id: schema.merchants.id })
    .from(schema.merchants)
    .where(eq(schema.merchants.razorpayKeyId, keyId))
    .limit(1);
  return again[0]!.id;
}

/**
 * Customers are keyed on contact details because Razorpay only supplies a
 * `customer_id` when the merchant created one explicitly.
 *
 * Phone is preferred over email, and that ordering is load-bearing. Keying on
 * email first split one real person into two customer rows the moment they paid
 * from a different address — which silently disarms the fatigue cap, since
 * "max 3 contacts in 7 days" is counted per customer row. A phone number is the
 * stabler identity in Indian payments and Razorpay collects it on every attempt.
 */
async function upsertCustomer(
  mid: string,
  p: { email?: string; contact?: string | number; customer_id?: string | null },
): Promise<string | null> {
  const email = p.email?.trim().toLowerCase() || null;
  const contact = p.contact ? String(p.contact).trim() : null;
  const externalId = p.customer_id || contact || email;
  if (!externalId) return null;

  const d = db();
  const [row] = await d
    .insert(schema.customers)
    .values({
      merchantId: mid,
      externalId,
      razorpayCustomerId: p.customer_id ?? null,
      email,
      contact,
      firstSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [schema.customers.merchantId, schema.customers.externalId],
      set: {
        email: sql`coalesce(excluded.email, ${schema.customers.email})`,
        contact: sql`coalesce(excluded.contact, ${schema.customers.contact})`,
      },
    })
    .returning({ id: schema.customers.id });
  return row?.id ?? null;
}

export async function upsertOrder(o: RzpOrder): Promise<string> {
  const mid = await merchantId();
  const [row] = await db()
    .insert(schema.orders)
    .values({
      merchantId: mid,
      razorpayOrderId: o.id,
      status: o.status,
      amountPaise: o.amount,
      amountPaidPaise: o.amount_paid ?? 0,
      amountDuePaise: o.amount_due ?? o.amount,
      attempts: o.attempts ?? 0,
      receipt: o.receipt,
      notes: notesToObject(o.notes),
      createdAtRzp: tsToDate(o.created_at),
    })
    .onConflictDoUpdate({
      target: schema.orders.razorpayOrderId,
      set: {
        // Only move forward. A stale event cannot walk the order backwards.
        status: sql`case when ${orderRankSql(sql`excluded.status`)} >= ${orderRankSql(schema.orders.status)}
                    then excluded.status else ${schema.orders.status} end`,
        amountPaidPaise: sql`greatest(${schema.orders.amountPaidPaise}, excluded.amount_paid_paise)`,
        amountDuePaise: sql`least(${schema.orders.amountDuePaise}, excluded.amount_due_paise)`,
        attempts: sql`greatest(${schema.orders.attempts}, excluded.attempts)`,
        receipt: sql`coalesce(excluded.receipt, ${schema.orders.receipt})`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: schema.orders.id });

  if (row) return row.id;
  const [existing] = await db()
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(eq(schema.orders.razorpayOrderId, o.id))
    .limit(1);
  return existing!.id;
}

function orderRankSql(col: unknown) {
  return sql`case ${col} when 'paid' then 2 when 'attempted' then 1 when 'created' then 0 else -1 end`;
}

function paymentRankSql(col: unknown) {
  return sql`case ${col} when 'refunded' then 4 when 'captured' then 3 when 'authorized' then 2
             when 'failed' then 1 when 'created' then 0 else -1 end`;
}

export async function upsertPayment(p: RzpPayment): Promise<string> {
  const mid = await merchantId();
  const customerId = await upsertCustomer(mid, p);

  let orderId: string | null = null;
  if (p.order_id) {
    const [o] = await db()
      .select({ id: schema.orders.id })
      .from(schema.orders)
      .where(eq(schema.orders.razorpayOrderId, p.order_id))
      .limit(1);
    orderId = o?.id ?? null;
  }

  const [row] = await db()
    .insert(schema.payments)
    .values({
      merchantId: mid,
      customerId,
      orderId,
      razorpayPaymentId: p.id,
      razorpayOrderId: p.order_id,
      status: p.status,
      amountPaise: p.amount,
      method: p.method ?? null,
      bank: p.bank ?? null,
      wallet: p.wallet ?? null,
      vpa: p.vpa ?? null,
      errorCode: p.error_code ?? null,
      errorDescription: p.error_description ?? null,
      errorSource: p.error_source ?? null,
      errorStep: p.error_step ?? null,
      errorReason: p.error_reason ?? null,
      notes: notesToObject(p.notes),
      createdAtRzp: tsToDate(p.created_at),
    })
    .onConflictDoUpdate({
      target: schema.payments.razorpayPaymentId,
      set: {
        // Forward-only. Out-of-order delivery cannot regress a payment.
        status: sql`case when ${paymentRankSql(sql`excluded.status`)} >= ${paymentRankSql(schema.payments.status)}
                    then excluded.status else ${schema.payments.status} end`,
        // Error fields only ever get filled in, never blanked by a later event.
        errorCode: sql`coalesce(excluded.error_code, ${schema.payments.errorCode})`,
        errorDescription: sql`coalesce(excluded.error_description, ${schema.payments.errorDescription})`,
        errorSource: sql`coalesce(excluded.error_source, ${schema.payments.errorSource})`,
        errorStep: sql`coalesce(excluded.error_step, ${schema.payments.errorStep})`,
        errorReason: sql`coalesce(excluded.error_reason, ${schema.payments.errorReason})`,
        notes: sql`coalesce(excluded.notes, ${schema.payments.notes})`,
        customerId: sql`coalesce(excluded.customer_id, ${schema.payments.customerId})`,
        orderId: sql`coalesce(excluded.order_id, ${schema.payments.orderId})`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: schema.payments.id });

  if (row) return row.id;
  const [existing] = await db()
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(eq(schema.payments.razorpayPaymentId, p.id))
    .limit(1);
  return existing!.id;
}

/** Invoice lifecycle rank. Terminal states sit above the payable ones. */
function invoiceRankSql(col: unknown) {
  return sql`case ${col} when 'deleted' then 6 when 'expired' then 5 when 'cancelled' then 4
             when 'paid' then 3 when 'partially_paid' then 2 when 'issued' then 1
             when 'draft' then 0 else -1 end`;
}

export async function upsertInvoice(inv: RzpInvoice): Promise<string> {
  const mid = await merchantId();
  const customerId = await upsertCustomer(mid, {
    customer_id: inv.customer_id ?? null,
    email: inv.customer_details?.email,
    contact: inv.customer_details?.contact,
  });

  const [row] = await db()
    .insert(schema.invoices)
    .values({
      merchantId: mid,
      customerId,
      razorpayInvoiceId: inv.id,
      status: inv.status,
      amountPaise: inv.amount,
      amountPaidPaise: inv.amount_paid ?? 0,
      amountDuePaise: inv.amount_due ?? inv.amount,
      shortUrl: inv.short_url,
      expireBy: tsToDate(inv.expire_by),
      issuedAt: tsToDate(inv.issued_at),
    })
    .onConflictDoUpdate({
      target: schema.invoices.razorpayInvoiceId,
      set: {
        // Forward-only, exactly as for orders and payments.
        status: sql`case when ${invoiceRankSql(sql`excluded.status`)} >= ${invoiceRankSql(schema.invoices.status)}
                    then excluded.status else ${schema.invoices.status} end`,
        amountPaidPaise: sql`greatest(${schema.invoices.amountPaidPaise}, excluded.amount_paid_paise)`,
        amountDuePaise: sql`least(${schema.invoices.amountDuePaise}, excluded.amount_due_paise)`,
        shortUrl: sql`coalesce(excluded.short_url, ${schema.invoices.shortUrl})`,
        expireBy: sql`coalesce(excluded.expire_by, ${schema.invoices.expireBy})`,
        issuedAt: sql`coalesce(excluded.issued_at, ${schema.invoices.issuedAt})`,
        customerId: sql`coalesce(excluded.customer_id, ${schema.invoices.customerId})`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: schema.invoices.id });

  if (row) return row.id;
  const [existing] = await db()
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(eq(schema.invoices.razorpayInvoiceId, inv.id))
    .limit(1);
  return existing!.id;
}

export async function upsertDowntime(dt: RzpDowntime): Promise<void> {
  await db()
    .insert(schema.downtimes)
    .values({
      razorpayDowntimeId: dt.id,
      method: dt.method,
      instrument: dt.instrument ?? {},
      status: dt.status,
      severity: dt.severity ?? null,
      begin: tsToDate(dt.begin),
      end: tsToDate(dt.end),
    })
    .onConflictDoUpdate({
      target: schema.downtimes.razorpayDowntimeId,
      set: {
        status: sql`excluded.status`,
        end: sql`coalesce(excluded."end", ${schema.downtimes.end})`,
        severity: sql`coalesce(excluded.severity, ${schema.downtimes.severity})`,
        updatedAt: new Date(),
      },
    });
}

/**
 * Closes downtimes Razorpay has stopped reporting as active.
 *
 * `GET /v1/payments/downtimes` returns only what is down RIGHT NOW — a resolved
 * outage simply stops appearing, and `payment.downtime.resolved` is not
 * guaranteed to arrive (DECISIONS.md §3: no ordering, no exactly-once). Upsert
 * alone therefore never sets `end`, and every downtime ever seen stays open
 * forever.
 *
 * That is not a cosmetic leak. Two rules read this table, and both fail open:
 * the policy engine defers any item whose instrument is "down", and the
 * degradation analyser treats an open downtime as the independent corroboration
 * that lets the LLM defer a whole cluster. Left uncorrected, both pin to ON for
 * every method we have ever seen fail.
 *
 * `end` is set to now — the moment we observed it was no longer active, not the
 * true resolution time, which Razorpay does not tell us retrospectively.
 *
 * `activeIds` must come from a SUCCESSFUL fetch. Pass null and this is a no-op,
 * because "we could not ask" must never read as "everything recovered".
 */
export async function closeResolvedDowntimes(activeIds: string[] | null): Promise<number> {
  if (activeIds === null) return 0;

  const closed = await db()
    .update(schema.downtimes)
    .set({ end: new Date(), status: "resolved", updatedAt: new Date() })
    .where(
      activeIds.length > 0
        ? and(
            isNull(schema.downtimes.end),
            notInArray(schema.downtimes.razorpayDowntimeId, activeIds),
          )
        : isNull(schema.downtimes.end),
    )
    .returning({ id: schema.downtimes.id });

  return closed.length;
}

/** Is any outage currently open for this payment method? */
export async function downtimeOpenFor(method: string | null): Promise<boolean> {
  if (!method) return false;
  const rows = await db()
    .select({ id: schema.downtimes.id })
    .from(schema.downtimes)
    .where(and(eq(schema.downtimes.method, method), isNull(schema.downtimes.end)))
    .limit(1);
  return rows.length > 0;
}
