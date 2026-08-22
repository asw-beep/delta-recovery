import "dotenv/config";
import { like, sql } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { analyseDegradation } from "../lib/degradation";
import { openRiskForFailedPayment } from "../lib/detect";
import { merchantId, upsertDowntime, upsertPayment } from "../lib/normalise";

/**
 * Exercises the degradation analyst against the live LLM.
 *
 * Two clusters are seeded deliberately:
 *
 *   A — HDFC netbanking, tight 40-minute window, WITH a live Razorpay downtime.
 *       Genuine infrastructure event. Should defer.
 *
 *   B — card declines spread over five hours, NO downtime, no spike.
 *       If the model proposes deferring this, corroboration must override it.
 *
 * Together they prove the trust boundary works in both directions: the model can
 * stop real work, but only when independent evidence agrees.
 *
 *   npx tsx scripts/verify-degradation.ts
 */

const RUN = `deg${Date.now().toString(36)}`;
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

async function seedFailure(id: string, opts: {
  method: string;
  bank: string;
  reason: string;
  minutesAgo: number;
  amount: number;
}) {
  await upsertPayment({
    id,
    entity: "payment",
    amount: opts.amount,
    currency: "INR",
    status: "failed",
    order_id: null,
    method: opts.method,
    bank: opts.bank,
    email: `${RUN}@example.com`,
    contact: "+919876543210",
    created_at: now() - opts.minutesAgo * 60,
    error_code: "BAD_REQUEST_ERROR",
    error_description: "Payment failed",
    error_source: opts.reason === "gateway_technical_error" ? "gateway" : "bank",
    error_step: "payment_authorization",
    error_reason: opts.reason,
  } as never);
  const riskId = await openRiskForFailedPayment(id, "reconciliation");
  // Backdate detection so the cluster spans a realistic window.
  if (riskId) {
    await db()
      .update(schema.riskItems)
      .set({ detectedAt: new Date(Date.now() - opts.minutesAgo * 60_000) })
      .where(sql`${schema.riskItems.id} = ${riskId}`);
  }
}

async function main() {
  console.log(`\nrun ${RUN}`);
  await merchantId();

  // Cluster A — real outage, tight window.
  for (let i = 0; i < 8; i++) {
    await seedFailure(`pay_${RUN}A${i}`, {
      method: "netbanking",
      bank: "HDFC",
      reason: "gateway_technical_error",
      minutesAgo: 10 + i * 5, // 40-minute span
      amount: 450_000 + i * 1000,
    });
  }
  await upsertDowntime({
    id: `down_${RUN}`,
    entity: "payment.downtime",
    method: "netbanking",
    begin: now() - 3600,
    end: null, // still open
    status: "started",
    severity: "high",
    instrument: { bank: "HDFC" },
  } as never);

  // Cluster B — ordinary declines, spread wide, no outage.
  for (let i = 0; i < 6; i++) {
    await seedFailure(`pay_${RUN}B${i}`, {
      method: "card",
      bank: "AXIS",
      reason: "card_declined",
      minutesAgo: 20 + i * 55, // ~5-hour span
      amount: 120_000,
    });
  }

  console.log("\nanalysing (live LLM call)...");
  const started = Date.now();
  const { findings, deferredRiskItemIds, llmUsed } = await analyseDegradation(6);
  console.log(`  ${Date.now() - started}ms, llmUsed=${llmUsed}\n`);

  for (const f of findings) {
    console.log(`  cluster ${f.id}`);
    console.log(`    ${f.count} failures, Rs ${(f.amountPaise / 100).toLocaleString("en-IN")}, ` +
      `${f.spanMinutes}min span, ${f.rateMultiple}x baseline, downtime=${f.downtimeCorroborated}`);
    console.log(`    cause=${f.cause} confidence=${f.confidence} -> ${f.disposition}` +
      (f.overridden ? "  [OVERRIDDEN]" : ""));
    console.log(`    "${f.rationale.slice(0, 130)}"`);
    if (f.overrideReason) console.log(`    override: ${f.overrideReason.slice(0, 160)}`);
    console.log("");
  }

  const a = findings.find((f) => f.id.startsWith("netbanking|HDFC"));
  const b = findings.find((f) => f.id.startsWith("card|AXIS"));

  check("outage cluster detected", Boolean(a), true);
  check("decline cluster detected", Boolean(b), true);
  check("outage cluster is corroborated by a live downtime record", a?.downtimeCorroborated, true);
  check("outage cluster is deferred", a?.disposition, "DEFER_UNTIL_RESOLVED");
  check("its items are held back", a!.riskItemIds.every((id) => deferredRiskItemIds.has(id)), true);

  check("decline cluster has no downtime corroboration", b?.downtimeCorroborated, false);
  check("decline cluster is NOT deferred", b?.disposition !== "DEFER_UNTIL_RESOLVED", true);
  check("its items proceed", b!.riskItemIds.some((id) => deferredRiskItemIds.has(id)), false);
  if (b?.overridden) {
    console.log("  NOTE: the model proposed deferring the decline cluster and evidence overrode it.");
    console.log("        That is the trust boundary doing its job, and it is a demo beat.\n");
  }

  // Cleanup
  const ids = await db()
    .select({ id: schema.riskItems.id })
    .from(schema.riskItems)
    .where(like(schema.riskItems.sourceEntityId, `%${RUN}%`));
  for (const { id } of ids) {
    await db().delete(schema.diagnoses).where(sql`${schema.diagnoses.riskItemId} = ${id}`);
  }
  await db().delete(schema.riskItems).where(like(schema.riskItems.sourceEntityId, `%${RUN}%`));
  await db().delete(schema.payments).where(like(schema.payments.razorpayPaymentId, `%${RUN}%`));
  await db().delete(schema.downtimes).where(like(schema.downtimes.razorpayDowntimeId, `%${RUN}%`));
  await db().delete(schema.customers).where(like(schema.customers.externalId, `%${RUN}%`));

  console.log(`${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error("\nverification crashed:", e);
  process.exit(1);
});
