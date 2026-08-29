import "dotenv/config";
import { eq, like, sql } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { attributeRecovery } from "../lib/batch";
import { executeAction, idempotencyKey } from "../lib/executor";
import { merchantId, upsertInvoice, upsertPayment } from "../lib/normalise";
import { openRiskForFailedPayment, openRiskForOverdueInvoice } from "../lib/detect";

/**
 * Proves the executor cannot double-act.
 *
 * The dangerous failure in this system is not a crash — it is a crash that
 * leaves a customer charged, or contacted, twice. Everything below runs in SIM
 * mode so no real Razorpay calls are made, but the idempotency ledger, the
 * unique index and the settled-state guard are the real ones.
 *
 *   npx tsx scripts/verify-executor.ts
 */

const RUN = `exe${Date.now().toString(36)}`;
const now = () => Math.floor(Date.now() / 1000);

/**
 * Customer identity is keyed `customer_id || contact || email` — phone before
 * email, since a phone is the stabler identity in Indian payments. So this run's
 * customer must be looked up by phone, and the phone must be unique per run or
 * every run's contacts pile onto one customer and the fatigue check below stops
 * meaning anything.
 */
const PHONE = `+9199${String(Date.now()).slice(-8)}`;

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

async function makeRisk(id: string, amount = 500_000) {
  await upsertPayment({
    id,
    entity: "payment",
    amount,
    currency: "INR",
    status: "failed",
    order_id: null,
    method: "card",
    bank: "HDFC",
    email: `${RUN}@example.com`,
    contact: PHONE,
    created_at: now(),
    error_code: "BAD_REQUEST_ERROR",
    error_description: "Payment failed",
    error_source: "bank",
    error_step: "payment_authorization",
    error_reason: "payment_failed",
  } as never);
  const riskId = await openRiskForFailedPayment(id, "reconciliation");
  const [c] = await db()
    .select({ id: schema.customers.id })
    .from(schema.customers)
    .where(eq(schema.customers.externalId, PHONE));
  return { riskId: riskId!, customerId: c?.id ?? null };
}

async function makeDecision(riskItemId: string) {
  const [d] = await db()
    .insert(schema.decisions)
    .values({
      riskItemId,
      proposedAction: "NUDGE_SMS",
      expectedValuePaise: 100_000,
      actionCostPaise: 15_020,
      verdict: "ALLOW",
      verdictReasons: ["test"],
      policyVersion: "1.0.0",
    })
    .returning({ id: schema.decisions.id });
  return d.id;
}

async function attemptCount(riskItemId: string) {
  const [r] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.actionAttempts)
    .innerJoin(schema.decisions, eq(schema.decisions.id, schema.actionAttempts.decisionId))
    .where(eq(schema.decisions.riskItemId, riskItemId));
  return r?.n ?? 0;
}

async function main() {
  console.log(`\nrun ${RUN}`);
  await merchantId();

  // ── 1. A repeated execution is absorbed ─────────────────────────────────
  console.log("\nrepeat execution (simulating a retry after a crash)");
  const a = await makeRisk(`pay_${RUN}A`);
  const decA = await makeDecision(a.riskId);
  const base = {
    decisionId: decA,
    riskItemId: a.riskId,
    riskClass: "failed_payment" as const,
    action: "NUDGE_SMS" as const,
    attemptNo: 1,
    sourceEntityId: `pay_${RUN}A`,
    sourceEntityType: "payment" as const,
    amountPaise: 500_000,
    customerId: a.customerId,
    customer: { email: `${RUN}@example.com` },
    mode: "sim" as const,
  };

  const first = await executeAction(base);
  check("first execution succeeds", first.status, "succeeded");
  const second = await executeAction(base);
  check("identical re-execution is skipped", second.status, "skipped_duplicate");
  check("exactly one attempt row exists", await attemptCount(a.riskId), 1);

  // ── 2. Concurrency: ten simultaneous attempts, one winner ───────────────
  console.log("\nten concurrent executions of the same action");
  const b = await makeRisk(`pay_${RUN}B`);
  const decB = await makeDecision(b.riskId);
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      executeAction({ ...base, decisionId: decB, riskItemId: b.riskId, sourceEntityId: `pay_${RUN}B`, customerId: b.customerId }),
    ),
  );
  check("exactly one succeeded", results.filter((r) => r.status === "succeeded").length, 1);
  check("the other nine were absorbed", results.filter((r) => r.status === "skipped_duplicate").length, 9);
  check("only one attempt row", await attemptCount(b.riskId), 1);

  // ── 3. The contact ledger is written for SIM too ────────────────────────
  // Otherwise a simulated batch would silently exempt itself from the fatigue cap.
  const [contacts] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.contacts)
    .where(eq(schema.contacts.customerId, b.customerId!));
  check("SIM contact counted against fatigue", (contacts?.n ?? 0) >= 1, true);

  // ── 4. A different attempt number is a genuinely new action ─────────────
  console.log("\nattempt 2 is a distinct action, not a duplicate");
  const third = await executeAction({ ...base, decisionId: decA, attemptNo: 2 });
  check("second attempt executes", third.status, "succeeded");
  check("two attempt rows now", await attemptCount(a.riskId), 2);
  check(
    "idempotency keys differ",
    idempotencyKey(a.riskId, "NUDGE_SMS", 1) !== idempotencyKey(a.riskId, "NUDGE_SMS", 2),
    true,
  );

  // ── 5. Never act on money that already arrived ──────────────────────────
  console.log("\nstate guard: entity settled between decision and execution");
  const c = await makeRisk(`pay_${RUN}C`);
  const decC = await makeDecision(c.riskId);
  // The payment is captured after the decision was made.
  await upsertPayment({
    id: `pay_${RUN}C`, entity: "payment", amount: 500_000, currency: "INR",
    status: "captured", order_id: null, method: "card", created_at: now(),
  } as never);
  const guarded = await executeAction({
    ...base, decisionId: decC, riskItemId: c.riskId, sourceEntityId: `pay_${RUN}C`,
    customerId: c.customerId,
  });
  check("execution aborted", guarded.status, "aborted_settled");

  // ── 6. Attribution closes the loop ──────────────────────────────────────
  console.log("\nattribution: a payment against our link closes the risk");
  const d = await makeRisk(`pay_${RUN}D`, 849_900);
  const decD = await makeDecision(d.riskId);
  const ok = await attributeRecovery(
    { decision_id: decD, risk_item_id: d.riskId },
    849_900,
    "payment_link.paid",
    null,
  );
  check("attributed", ok, true);
  const [outcome] = await db()
    .select({ amount: schema.outcomes.recoveredAmountPaise, result: schema.outcomes.result })
    .from(schema.outcomes)
    .where(eq(schema.outcomes.decisionId, decD));
  check("recovered amount recorded", outcome?.amount, 849_900);
  const [risk] = await db()
    .select({ state: schema.riskItems.state, reason: schema.riskItems.closedReason })
    .from(schema.riskItems)
    .where(eq(schema.riskItems.id, d.riskId));
  check("risk closed as recovered", risk?.state, "recovered");
  check("attributed to the intervention", risk?.reason, "recovered_after_intervention");

  // A duplicate delivery of the same paid event must not double-count revenue.
  await attributeRecovery({ decision_id: decD }, 849_900, "payment_link.paid", null);
  const [outCount] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.outcomes)
    .where(eq(schema.outcomes.decisionId, decD));
  check("duplicate paid-event does not double-count", outCount?.n, 1);

  // ── 7. Receivables never mint a payment link ────────────────────────────
  console.log("\nreceivables use the existing invoice");
  await upsertInvoice({
    id: `inv_${RUN}A`, entity: "invoice", status: "issued",
    amount: 2_500_000, amount_paid: 0, amount_due: 2_500_000, currency: "INR",
    short_url: "https://rzp.io/i/x", customer_id: null,
    customer_details: { email: `${RUN}b@example.com` },
    order_id: null, expire_by: now() - 5 * 86400,
    issued_at: now() - 20 * 86400, created_at: now() - 20 * 86400,
  } as never);
  const invRisk = await openRiskForOverdueInvoice(`inv_${RUN}A`, "reconciliation");
  const decI = await makeDecision(invRisk!);
  const invRes = await executeAction({
    ...base, decisionId: decI, riskItemId: invRisk!, riskClass: "overdue_receivable",
    action: "CHASE_INVOICE", sourceEntityId: `inv_${RUN}A`, sourceEntityType: "invoice",
    amountPaise: 2_500_000, customerId: null,
  });
  check("invoice chase executes", invRes.status, "succeeded");

  // ── cleanup ─────────────────────────────────────────────────────────────
  const ids = await db()
    .select({ id: schema.riskItems.id })
    .from(schema.riskItems)
    .where(like(schema.riskItems.sourceEntityId, `%${RUN}%`));
  for (const { id } of ids) {
    const decs = await db().select({ id: schema.decisions.id }).from(schema.decisions).where(eq(schema.decisions.riskItemId, id));
    for (const d0 of decs) {
      await db().delete(schema.actionAttempts).where(eq(schema.actionAttempts.decisionId, d0.id));
      await db().delete(schema.outcomes).where(eq(schema.outcomes.decisionId, d0.id));
      await db().delete(schema.contacts).where(eq(schema.contacts.decisionId, d0.id));
      await db().delete(schema.escalations).where(eq(schema.escalations.decisionId, d0.id));
    }
    await db().delete(schema.decisions).where(eq(schema.decisions.riskItemId, id));
    await db().delete(schema.scores).where(eq(schema.scores.riskItemId, id));
  }
  await db().delete(schema.riskItems).where(like(schema.riskItems.sourceEntityId, `%${RUN}%`));
  await db().delete(schema.payments).where(like(schema.payments.razorpayPaymentId, `%${RUN}%`));
  await db().delete(schema.invoices).where(like(schema.invoices.razorpayInvoiceId, `%${RUN}%`));
  await db().delete(schema.customers).where(like(schema.customers.externalId, `%${RUN}%`));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error("\nverification crashed:", e);
  process.exit(1);
});
