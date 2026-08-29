import "dotenv/config";
import { eq, like, sql } from "drizzle-orm";
import { db, schema } from "../lib/db";
import {
  closeSettledRisks,
  openRiskForAbandonedCheckout,
  openRiskForFailedPayment,
  openRiskForOverdueInvoice,
} from "../lib/detect";
import { upsertInvoice, upsertOrder, upsertPayment } from "../lib/normalise";
import { processPendingEvents } from "../lib/process";

/**
 * Exercises the ingestion guarantees against the real database, across all
 * three risk classes.
 *
 * Typecheck cannot tell us whether the forward-only upsert SQL or the partial
 * unique index actually behave, so this drives them with synthetic deliveries
 * and asserts outcomes. This is the ingestion gate.
 *
 *   npx tsx scripts/verify-ingestion.ts
 */

const RUN = `vfy${Date.now().toString(36)}`;
const HOUR = 3600;
const now = () => Math.floor(Date.now() / 1000);

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}` +
      (ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`),
  );
  ok ? passed++ : failed++;
}

function payment(over: Record<string, unknown> = {}) {
  return {
    id: `pay_${RUN}A`,
    entity: "payment",
    amount: 849900,
    currency: "INR",
    status: "failed",
    order_id: `order_${RUN}A`,
    method: "card",
    bank: "HDFC",
    email: `${RUN}@example.com`,
    contact: "+919876543210",
    created_at: now(),
    error_code: "BAD_REQUEST_ERROR",
    error_description: "Payment failed",
    error_source: "bank",
    error_step: "payment_authorization",
    error_reason: "payment_failed",
    ...over,
  };
}

function order(over: Record<string, unknown> = {}) {
  return {
    id: `order_${RUN}A`,
    entity: "order",
    amount: 849900,
    amount_paid: 0,
    amount_due: 849900,
    currency: "INR",
    receipt: `rcpt_${RUN}`,
    status: "attempted",
    attempts: 1,
    created_at: now(),
    ...over,
  };
}

function invoice(over: Record<string, unknown> = {}) {
  return {
    id: `inv_${RUN}A`,
    entity: "invoice",
    status: "issued",
    amount: 2_500_000,
    amount_paid: 0,
    amount_due: 2_500_000,
    currency: "INR",
    short_url: "https://rzp.io/i/test",
    customer_id: null,
    customer_details: { email: `${RUN}b@example.com`, contact: "+919812345678" },
    order_id: null,
    expire_by: now() - 5 * 86400, // overdue by 5 days
    issued_at: now() - 20 * 86400,
    created_at: now() - 20 * 86400,
    ...over,
  };
}

async function deliver(eventId: string, event: string, payload: Record<string, unknown>) {
  await db()
    .insert(schema.webhookEvents)
    .values({ razorpayEventId: eventId, event, payload, signatureValid: true })
    .onConflictDoNothing({ target: schema.webhookEvents.razorpayEventId });
}

async function risks(sourceId: string) {
  const [r] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.riskItems)
    .where(eq(schema.riskItems.sourceEntityId, sourceId));
  return r?.n ?? 0;
}

async function riskRow(sourceId: string) {
  const [r] = await db()
    .select({
      cls: schema.riskItems.class,
      state: schema.riskItems.state,
      amount: schema.riskItems.amountAtRiskPaise,
      reason: schema.riskItems.closedReason,
      via: schema.riskItems.detectedVia,
    })
    .from(schema.riskItems)
    .where(eq(schema.riskItems.sourceEntityId, sourceId));
  return r;
}

async function paymentStatus(id: string) {
  const [r] = await db()
    .select({ s: schema.payments.status })
    .from(schema.payments)
    .where(eq(schema.payments.razorpayPaymentId, id));
  return r?.s ?? null;
}

async function main() {
  console.log(`\nrun ${RUN}`);

  // ── FAILED PAYMENT ────────────────────────────────────────────────────────
  console.log("\nfailed payment");
  await deliver(`evt_${RUN}_1`, "payment.failed", {
    event: "payment.failed",
    payload: { payment: { entity: payment() }, order: { entity: order() } },
  });
  await processPendingEvents(50);
  check("payment stored as failed", await paymentStatus(`pay_${RUN}A`), "failed");
  check("one risk item opened", await risks(`pay_${RUN}A`), 1);

  console.log("\nduplicate delivery");
  await deliver(`evt_${RUN}_1`, "payment.failed", {
    event: "payment.failed",
    payload: { payment: { entity: payment() } },
  });
  const [dupes] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.razorpayEventId, `evt_${RUN}_1`));
  check("event row not duplicated", dupes?.n, 1);
  await processPendingEvents(50);
  check("risk item not duplicated", await risks(`pay_${RUN}A`), 1);

  console.log("\nout-of-order delivery");
  const B = payment({ id: `pay_${RUN}B`, status: "captured", order_id: null, error_reason: null, error_code: null });
  await deliver(`evt_${RUN}_2`, "payment.captured", { event: "payment.captured", payload: { payment: { entity: B } } });
  await processPendingEvents(50);
  check("stored as captured", await paymentStatus(`pay_${RUN}B`), "captured");
  await deliver(`evt_${RUN}_3`, "payment.authorized", {
    event: "payment.authorized",
    payload: { payment: { entity: { ...B, status: "authorized" } } },
  });
  await processPendingEvents(50);
  check("late authorized did NOT regress it", await paymentStatus(`pay_${RUN}B`), "captured");

  console.log("\nreconciliation convergence");
  check("no second risk item", await openRiskForFailedPayment(`pay_${RUN}A`, "reconciliation"), null);
  check("still exactly one", await risks(`pay_${RUN}A`), 1);

  // ── ABANDONED CHECKOUT ────────────────────────────────────────────────────
  console.log("\nabandoned checkout");
  // Fresh order: still mid-checkout, must NOT be flagged.
  await upsertOrder(order({ id: `order_${RUN}FRESH`, created_at: now() - 10 * 60 }) as never);
  check(
    "order inside dwell window is not flagged",
    await openRiskForAbandonedCheckout(`order_${RUN}FRESH`, "reconciliation"),
    null,
  );

  // Aged, unpaid order: is abandonment.
  await upsertOrder(order({ id: `order_${RUN}OLD`, created_at: now() - 6 * HOUR }) as never);
  const ab = await openRiskForAbandonedCheckout(`order_${RUN}OLD`, "reconciliation");
  check("aged unpaid order opens a risk", ab !== null, true);
  const abRow = await riskRow(`order_${RUN}OLD`);
  check("classified as abandoned_checkout", abRow?.cls, "abandoned_checkout");
  check("amount at risk is amount_due", abRow?.amount, 849900);
  check("no duplicate on re-sweep", await openRiskForAbandonedCheckout(`order_${RUN}OLD`, "reconciliation"), null);

  // Paid order must never be flagged.
  await upsertOrder(order({ id: `order_${RUN}PAID`, created_at: now() - 6 * HOUR, status: "paid", amount_paid: 849900, amount_due: 0 }) as never);
  check("paid order is not flagged", await openRiskForAbandonedCheckout(`order_${RUN}PAID`, "reconciliation"), null);

  // ── OVERDUE RECEIVABLE ────────────────────────────────────────────────────
  console.log("\noverdue receivable");
  await upsertInvoice(invoice() as never);
  const inv = await openRiskForOverdueInvoice(`inv_${RUN}A`, "reconciliation");
  check("overdue invoice opens a risk", inv !== null, true);
  const invRow = await riskRow(`inv_${RUN}A`);
  check("classified as overdue_receivable", invRow?.cls, "overdue_receivable");
  check("amount at risk is amount_due", invRow?.amount, 2_500_000);

  // Not yet due.
  await upsertInvoice(invoice({ id: `inv_${RUN}FUTURE`, expire_by: now() + 10 * 86400 }) as never);
  check("invoice not yet due is not flagged", await openRiskForOverdueInvoice(`inv_${RUN}FUTURE`, "reconciliation"), null);

  // Draft invoices cannot be notified, so must never enter the queue.
  await upsertInvoice(invoice({ id: `inv_${RUN}DRAFT`, status: "draft" }) as never);
  check("draft invoice is not flagged", await openRiskForOverdueInvoice(`inv_${RUN}DRAFT`, "reconciliation"), null);

  // ── SELF-RECOVERY, ALL CLASSES ────────────────────────────────────────────
  console.log("\nself-recovery closes risks in every class");
  await deliver(`evt_${RUN}_4`, "order.paid", {
    event: "order.paid",
    payload: {
      order: { entity: order({ status: "paid", amount_paid: 849900, amount_due: 0 }) },
      payment: { entity: payment({ id: `pay_${RUN}D`, status: "captured", error_reason: null, error_code: null }) },
    },
  });
  await upsertOrder(order({ id: `order_${RUN}OLD`, created_at: now() - 6 * HOUR, status: "paid", amount_paid: 849900, amount_due: 0 }) as never);
  await upsertInvoice(invoice({ status: "paid", amount_paid: 2_500_000, amount_due: 0 }) as never);

  const res = await processPendingEvents(50);
  check("three risks closed as self-recovered", res.selfRecovered, 3);
  check("none credited to an intervention", res.settledUnattributed, 0);
  check("failed payment closed", (await riskRow(`pay_${RUN}A`))?.reason, "self_recovered_without_intervention");
  check("abandonment closed", (await riskRow(`order_${RUN}OLD`))?.reason, "self_recovered_without_intervention");
  check("receivable closed", (await riskRow(`inv_${RUN}A`))?.reason, "self_recovered_without_intervention");

  // ── AN ITEM WE ACTED ON MUST STILL BE CLOSEABLE ───────────────────────────
  // The executor marks an item `in_progress` the moment it acts. The sweep used
  // to look only at `open`, so from that moment on it could never close the item
  // again — and acted-on items are the population most likely to settle. They
  // accumulated in limbo, uncounted. Observed live on 29 Aug.
  console.log("\nan item already acted on still closes when the money arrives");
  // Its own order: the default fixture order was paid above, and the opener
  // correctly refuses to raise a risk whose money has already arrived.
  await upsertPayment(
    payment({ id: `pay_${RUN}E`, status: "failed", order_id: `order_${RUN}E` }) as never,
  );
  const actedId = await openRiskForFailedPayment(`pay_${RUN}E`, "reconciliation");
  check("a risk opened for the acted-on item", actedId !== null, true);

  await db()
    .update(schema.riskItems)
    .set({ state: "in_progress" })
    .where(eq(schema.riskItems.id, actedId!));

  // A real contact went out, exactly as the executor would have recorded it.
  // Without this the item looks organic and closes as self-recovered.
  const [actedDecision] = await db()
    .insert(schema.decisions)
    .values({
      riskItemId: actedId!,
      proposedAction: "NUDGE_SMS",
      expectedValuePaise: 100_000,
      actionCostPaise: 20,
      verdict: "ALLOW",
      verdictReasons: ["test"],
      policyVersion: "1.0.0",
    })
    .returning({ id: schema.decisions.id });
  await db().insert(schema.actionAttempts).values({
    decisionId: actedDecision.id,
    idempotencyKey: `${actedId}:NUDGE_SMS:1`,
    attemptNo: 1,
    action: "NUDGE_SMS",
    mode: "sim",
    status: "succeeded",
  });

  // The money now arrives.
  await upsertPayment(
    payment({
      id: `pay_${RUN}E`,
      status: "captured",
      order_id: `order_${RUN}E`,
      error_reason: null,
      error_code: null,
    }) as never,
  );

  const acted = await closeSettledRisks();
  const actedRow = await riskRow(`pay_${RUN}E`);
  check("in_progress item is no longer stuck open", actedRow?.state, "recovered");
  check(
    "closed as unattributed, not credited to us",
    actedRow?.reason,
    "settled_unattributed",
  );
  check("counted as unattributed", acted.settledUnattributed >= 1, true);

  // ── cleanup ───────────────────────────────────────────────────────────────
  // Children before parents: the acted-on case above writes a decision and an
  // attempt, and both reference the risk item.
  await db().execute(sql`
    delete from action_attempts a
    using decisions d, risk_items ri
    where a.decision_id = d.id and d.risk_item_id = ri.id
      and ri.source_entity_id like ${`%${RUN}%`}
  `);
  await db().execute(sql`
    delete from decisions d
    using risk_items ri
    where d.risk_item_id = ri.id and ri.source_entity_id like ${`%${RUN}%`}
  `);
  await db().delete(schema.riskItems).where(like(schema.riskItems.sourceEntityId, `%${RUN}%`));
  await db().delete(schema.payments).where(like(schema.payments.razorpayPaymentId, `%${RUN}%`));
  await db().delete(schema.orders).where(like(schema.orders.razorpayOrderId, `%${RUN}%`));
  await db().delete(schema.invoices).where(like(schema.invoices.razorpayInvoiceId, `%${RUN}%`));
  await db().delete(schema.webhookEvents).where(like(schema.webhookEvents.razorpayEventId, `%${RUN}%`));
  await db().delete(schema.customers).where(like(schema.customers.externalId, `%${RUN}%`));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error("\nverification crashed:", e);
  process.exit(1);
});
