import "dotenv/config";
import { eq, inArray, like, sql } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { openRiskForFailedPayment } from "../lib/detect";
import { processPendingEvents } from "../lib/process";

/**
 * Exercises the ingestion guarantees against the real database.
 *
 * Typecheck cannot tell us whether the forward-only upsert SQL or the partial
 * unique index actually behave, so this drives them with synthetic webhook
 * deliveries and asserts the outcome. This is the Day 2 gate.
 *
 *   npx tsx scripts/verify-ingestion.ts
 */

const RUN = `vfy${Date.now().toString(36)}`;
let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
  ok ? passed++ : failed++;
}

function paymentEntity(over: Record<string, unknown> = {}) {
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
    created_at: Math.floor(Date.now() / 1000),
    error_code: "BAD_REQUEST_ERROR",
    error_description: "Payment failed",
    error_source: "bank",
    error_step: "payment_authorization",
    error_reason: "payment_failed",
    ...over,
  };
}

function orderEntity(over: Record<string, unknown> = {}) {
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
    created_at: Math.floor(Date.now() / 1000),
    ...over,
  };
}

async function deliver(eventId: string, event: string, payload: Record<string, unknown>) {
  await db()
    .insert(schema.webhookEvents)
    .values({ razorpayEventId: eventId, event, payload, signatureValid: true })
    .onConflictDoNothing({ target: schema.webhookEvents.razorpayEventId });
}

async function countRisks(sourceId: string) {
  const [r] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.riskItems)
    .where(eq(schema.riskItems.sourceEntityId, sourceId));
  return r?.n ?? 0;
}

async function paymentStatus(rzpId: string) {
  const [r] = await db()
    .select({ s: schema.payments.status })
    .from(schema.payments)
    .where(eq(schema.payments.razorpayPaymentId, rzpId));
  return r?.s ?? null;
}

async function main() {
  console.log(`\nrun ${RUN}\n`);

  // ── 1. A failed payment produces exactly one risk item ────────────────────
  console.log("failed payment -> risk item");
  await deliver(`evt_${RUN}_1`, "payment.failed", {
    event: "payment.failed",
    payload: { payment: { entity: paymentEntity() }, order: { entity: orderEntity() } },
  });
  await processPendingEvents(50);
  check("payment stored as failed", await paymentStatus(`pay_${RUN}A`), "failed");
  check("one risk item opened", await countRisks(`pay_${RUN}A`), 1);

  // ── 2. Duplicate delivery is absorbed ────────────────────────────────────
  console.log("\nduplicate delivery");
  await deliver(`evt_${RUN}_1`, "payment.failed", {
    event: "payment.failed",
    payload: { payment: { entity: paymentEntity() } },
  });
  const [dupes] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.razorpayEventId, `evt_${RUN}_1`));
  check("event row not duplicated", dupes?.n, 1);
  await processPendingEvents(50);
  check("risk item not duplicated", await countRisks(`pay_${RUN}A`), 1);

  // ── 3. Out-of-order delivery cannot regress state ────────────────────────
  console.log("\nout-of-order delivery (captured, then a late authorized)");
  const B = paymentEntity({ id: `pay_${RUN}B`, status: "captured", order_id: null, error_reason: null, error_code: null });
  await deliver(`evt_${RUN}_2`, "payment.captured", {
    event: "payment.captured",
    payload: { payment: { entity: B } },
  });
  await processPendingEvents(50);
  check("stored as captured", await paymentStatus(`pay_${RUN}B`), "captured");

  await deliver(`evt_${RUN}_3`, "payment.authorized", {
    event: "payment.authorized",
    payload: { payment: { entity: { ...B, status: "authorized" } } },
  });
  await processPendingEvents(50);
  check("late authorized did NOT regress it", await paymentStatus(`pay_${RUN}B`), "captured");

  // ── 4. Reconciliation converges, never double-opens ──────────────────────
  console.log("\nreconciliation on a payment the webhook already covered");
  const again = await openRiskForFailedPayment(`pay_${RUN}A`, "reconciliation");
  check("no second risk item created", again, null);
  check("still exactly one", await countRisks(`pay_${RUN}A`), 1);

  // ── 5. Reconciliation catches what the webhook never delivered ───────────
  console.log("\nreconciliation-only detection (no webhook ever arrives)");
  const { upsertPayment } = await import("../lib/normalise");
  await upsertPayment(paymentEntity({ id: `pay_${RUN}C`, order_id: null }) as never);
  const opened = await openRiskForFailedPayment(`pay_${RUN}C`, "reconciliation");
  check("risk opened by the sweep", opened !== null, true);
  const [via] = await db()
    .select({ v: schema.riskItems.detectedVia })
    .from(schema.riskItems)
    .where(eq(schema.riskItems.sourceEntityId, `pay_${RUN}C`));
  check("attributed to reconciliation", via?.v, "reconciliation");

  // ── 6. Self-recovery closes the risk without any intervention ────────────
  console.log("\nself-recovery (order paid, we never contacted anyone)");
  await deliver(`evt_${RUN}_4`, "order.paid", {
    event: "order.paid",
    payload: {
      order: { entity: orderEntity({ status: "paid", amount_paid: 849900, amount_due: 0 }) },
      payment: { entity: paymentEntity({ id: `pay_${RUN}D`, status: "captured", error_reason: null, error_code: null }) },
    },
  });
  const res = await processPendingEvents(50);
  check("one risk closed as self-recovered", res.selfRecovered, 1);
  const [state] = await db()
    .select({ s: schema.riskItems.state, reason: schema.riskItems.closedReason })
    .from(schema.riskItems)
    .where(eq(schema.riskItems.sourceEntityId, `pay_${RUN}A`));
  check("state is recovered", state?.s, "recovered");
  check("reason recorded", state?.reason, "self_recovered_without_intervention");

  // ── cleanup ──────────────────────────────────────────────────────────────
  await db().delete(schema.riskItems).where(like(schema.riskItems.sourceEntityId, `pay_${RUN}%`));
  await db().delete(schema.payments).where(like(schema.payments.razorpayPaymentId, `pay_${RUN}%`));
  await db().delete(schema.orders).where(like(schema.orders.razorpayOrderId, `order_${RUN}%`));
  await db().delete(schema.webhookEvents).where(like(schema.webhookEvents.razorpayEventId, `evt_${RUN}%`));
  await db().delete(schema.customers).where(like(schema.customers.externalId, `${RUN}%`));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error("\nverification crashed:", e);
  process.exit(1);
});
