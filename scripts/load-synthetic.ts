import "dotenv/config";
import { readFile } from "node:fs/promises";
import { and, eq, like, or, sql } from "drizzle-orm";
import { db, schema } from "../lib/db";
import {
  openRiskForAbandonedCheckout,
  openRiskForFailedPayment,
  openRiskForOverdueInvoice,
} from "../lib/detect";
import { upsertInvoice, upsertOrder, upsertPayment } from "../lib/normalise";
import { TAXONOMY } from "../lib/taxonomy";
import type { RzpInvoice, RzpOrder, RzpPayment } from "../lib/razorpay";

/**
 * Loads synthetic merchant traffic so the pipeline can be exercised on paths the
 * test account has not produced organically.
 *
 *   npx tsx scripts/load-synthetic.ts <file.json>            validate only
 *   npx tsx scripts/load-synthetic.ts <file.json> --commit   write
 *   npx tsx scripts/load-synthetic.ts --purge                remove every synthetic row
 *
 * See docs/synthetic-data-spec.md for the format and the reasoning.
 *
 * Two things this deliberately does NOT do:
 *
 *   - It never writes a risk item, decision or outcome. It writes payments,
 *     orders and invoices, then calls the same detectors the webhook path calls.
 *     Synthetic input, real pipeline — anything else would be fabricating a
 *     result, which DECISIONS.md §2 forbids outright.
 *
 *   - It never loads a record that cannot later be identified as synthetic.
 *     Both markers are mandatory, so no synthetic row can quietly come to look
 *     like live Razorpay traffic in a screenshot.
 */

const SYN = "SYN";

interface Batch {
  _meta?: Record<string, unknown>;
  orders?: RzpOrder[];
  payments?: RzpPayment[];
  invoices?: RzpInvoice[];
}

const problems: string[] = [];
function fail(where: string, msg: string) {
  problems.push(`${where}: ${msg}`);
}

function notesOf(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Both markers, on every record. One is a typo away from being lost; two are not. */
function checkMarkers(kind: string, id: unknown, notes: unknown) {
  const where = `${kind} ${String(id)}`;
  if (typeof id !== "string" || !id.includes(SYN)) {
    fail(where, `id must contain "${SYN}" so it is identifiable as synthetic`);
  }
  if (String(notesOf(notes).synthetic) !== "true") {
    fail(where, 'notes.synthetic must be the string "true"');
  }
}

function validate(batch: Batch) {
  const orders = batch.orders ?? [];
  const payments = batch.payments ?? [];
  const invoices = batch.invoices ?? [];
  const orderIds = new Set(orders.map((o) => o.id));

  for (const o of orders) {
    const where = `order ${o.id}`;
    checkMarkers("order", o.id, o.notes);
    if (typeof o.amount !== "number" || o.amount <= 0) fail(where, "amount must be positive paise");
    if (o.amount_due !== o.amount - o.amount_paid) {
      fail(where, `amount_due ${o.amount_due} != amount ${o.amount} - amount_paid ${o.amount_paid}`);
    }
    if (!["created", "attempted", "paid"].includes(o.status)) {
      fail(where, `status "${o.status}" is not created|attempted|paid`);
    }
    if (!Number.isFinite(o.created_at) || o.created_at > 4_000_000_000) {
      fail(where, "created_at must be unix SECONDS, not milliseconds");
    }
  }

  for (const p of payments) {
    const where = `payment ${p.id}`;
    checkMarkers("payment", p.id, p.notes);
    if (typeof p.amount !== "number" || p.amount <= 0) fail(where, "amount must be positive paise");
    if (!["created", "authorized", "captured", "refunded", "failed"].includes(p.status)) {
      fail(where, `status "${p.status}" is not a Razorpay payment status`);
    }
    if (p.order_id && !orderIds.has(p.order_id)) {
      fail(where, `order_id ${p.order_id} is not in this batch`);
    }
    if (!Number.isFinite(p.created_at) || p.created_at > 4_000_000_000) {
      fail(where, "created_at must be unix SECONDS, not milliseconds");
    }
    if (!p.contact && !p.email) {
      fail(where, "needs contact or email — otherwise no customer is created and fatigue caps cannot bind");
    }
    // The important one: an unmapped reason raises at scoring time by design,
    // so catching it here is the difference between a bad batch and a crash.
    if (p.status === "failed") {
      if (!p.error_reason) {
        fail(where, "a failed payment needs an error_reason");
      } else if (!TAXONOMY[p.error_reason]) {
        fail(where, `error_reason "${p.error_reason}" is not in the taxonomy — it would raise`);
      }
    }
  }

  for (const inv of invoices) {
    const where = `invoice ${inv.id}`;
    checkMarkers("invoice", inv.id, inv.notes);
    if (inv.amount_due !== inv.amount - inv.amount_paid) {
      fail(where, "amount_due != amount - amount_paid");
    }
    if (inv.status === "issued" && inv.amount_due > 0) {
      const due = inv.expire_by ?? (inv.issued_at ? inv.issued_at + 15 * 86400 : null);
      if (!due) fail(where, "issued invoice needs expire_by or issued_at");
      else if (due * 1000 > Date.now()) {
        fail(where, "expire_by is in the future — it will never be detected as overdue");
      }
    }
  }
}

/** What the batch is shaped to exercise, so a thin batch is visible before loading. */
function summarise(batch: Batch) {
  const payments = batch.payments ?? [];
  const failed = payments.filter((p) => p.status === "failed");
  const byClass: Record<string, number> = {};
  for (const p of failed) {
    const cls = p.error_reason ? (TAXONOMY[p.error_reason] ?? "UNMAPPED") : "MISSING";
    byClass[cls] = (byClass[cls] ?? 0) + 1;
  }

  const contacts = new Map<string, number>();
  for (const p of failed) {
    const k = String(p.contact ?? p.email ?? "");
    if (k) contacts.set(k, (contacts.get(k) ?? 0) + 1);
  }
  const repeat = [...contacts.values()].filter((n) => n >= 4).length;

  // Self-recovery: an order that ended up paid but had a failed payment first.
  const failedOrders = new Set(failed.map((p) => p.order_id).filter(Boolean));
  const selfRecovered = (batch.orders ?? []).filter(
    (o) => o.status === "paid" && failedOrders.has(o.id),
  ).length;

  const highValue = failed.filter((p) => p.amount >= 2_500_000).length;
  const fraud = failed.filter((p) => p.error_reason === "payment_risk_check_failed").length;

  console.log("\nwhat this batch exercises");
  console.log(`  failed payments      ${failed.length}`);
  for (const [k, v] of Object.entries(byClass).sort()) {
    console.log(`    ${k.padEnd(18)} ${v}`);
  }
  console.log(`  high value (ESCALATE) ${highValue}`);
  console.log(`  fraud flag (ESCALATE) ${fraud}`);
  console.log(`  customers hit 4+ times (fatigue STOP) ${repeat}`);
  console.log(`  self-recoveries       ${selfRecovered}` +
    (failed.length > 0 ? `  (${Math.round((selfRecovered / failed.length) * 100)}% of failures)` : ""));
  if (selfRecovered === 0) {
    console.log("    ^ none. Self-recovery IS the thesis; a batch without it");
    console.log("      makes Delta look like every other dunning tool.");
  }
}

async function purge() {
  const d = db();
  const synLike = `%${SYN}%`;

  // Order matters: children before parents.
  const items = await d
    .select({ id: schema.riskItems.id })
    .from(schema.riskItems)
    .where(like(schema.riskItems.sourceEntityId, synLike));
  const ids = items.map((i) => i.id);

  if (ids.length > 0) {
    const decs = await d
      .select({ id: schema.decisions.id })
      .from(schema.decisions)
      .where(sql`${schema.decisions.riskItemId} in ${ids}`);
    const decIds = decs.map((x) => x.id);
    if (decIds.length > 0) {
      await d.delete(schema.outcomes).where(sql`${schema.outcomes.decisionId} in ${decIds}`);
      await d.delete(schema.actionAttempts).where(sql`${schema.actionAttempts.decisionId} in ${decIds}`);
      await d.delete(schema.escalations).where(sql`${schema.escalations.decisionId} in ${decIds}`);
      await d.delete(schema.contacts).where(sql`${schema.contacts.decisionId} in ${decIds}`);
      await d.delete(schema.decisions).where(sql`${schema.decisions.id} in ${decIds}`);
    }
    await d.delete(schema.scores).where(sql`${schema.scores.riskItemId} in ${ids}`);
    await d.delete(schema.diagnoses).where(sql`${schema.diagnoses.riskItemId} in ${ids}`);
    await d.delete(schema.riskItems).where(sql`${schema.riskItems.id} in ${ids}`);
  }

  const p = await d.delete(schema.payments).where(like(schema.payments.razorpayPaymentId, synLike)).returning({ id: schema.payments.id });
  const o = await d.delete(schema.orders).where(like(schema.orders.razorpayOrderId, synLike)).returning({ id: schema.orders.id });
  const i = await d.delete(schema.invoices).where(like(schema.invoices.razorpayInvoiceId, synLike)).returning({ id: schema.invoices.id });
  const c = await d
    .delete(schema.customers)
    .where(or(like(schema.customers.externalId, synLike), like(schema.customers.email, "%@example.com")))
    .returning({ id: schema.customers.id });

  console.log(
    `purged: ${ids.length} risk items, ${p.length} payments, ${o.length} orders, ` +
      `${i.length} invoices, ${c.length} customers`,
  );
}

async function main() {
  if (process.argv.includes("--purge")) {
    await purge();
    return;
  }

  const file = process.argv.find((a) => a.endsWith(".json"));
  if (!file) {
    console.error("usage: load-synthetic.ts <file.json> [--commit] | --purge");
    process.exit(1);
  }

  const batch = JSON.parse(await readFile(file, "utf8")) as Batch;
  const counts = {
    orders: batch.orders?.length ?? 0,
    payments: batch.payments?.length ?? 0,
    invoices: batch.invoices?.length ?? 0,
  };
  console.log(`\n${file}`);
  console.log(`  ${counts.orders} orders · ${counts.payments} payments · ${counts.invoices} invoices`);
  if (batch._meta) console.log(`  meta: ${JSON.stringify(batch._meta)}`);

  validate(batch);
  summarise(batch);

  if (problems.length > 0) {
    console.log(`\n${problems.length} problem(s) — nothing was written:\n`);
    for (const p of problems.slice(0, 40)) console.log(`  ${p}`);
    if (problems.length > 40) console.log(`  … and ${problems.length - 40} more`);
    process.exit(1);
  }
  console.log("\nvalidation passed");

  if (!process.argv.includes("--commit")) {
    console.log("dry run — pass --commit to write\n");
    return;
  }

  // Orders first so payments can attach to them.
  for (const o of batch.orders ?? []) await upsertOrder(o);
  for (const p of batch.payments ?? []) await upsertPayment(p);
  for (const inv of batch.invoices ?? []) await upsertInvoice(inv);

  // Then the real detectors — the same ones the webhook path calls.
  let opened = { failed_payment: 0, abandoned_checkout: 0, overdue_receivable: 0 };
  for (const p of batch.payments ?? []) {
    if (p.status === "failed" && (await openRiskForFailedPayment(p.id, "reconciliation"))) {
      opened.failed_payment++;
    }
  }
  for (const o of batch.orders ?? []) {
    if (await openRiskForAbandonedCheckout(o.id, "reconciliation")) opened.abandoned_checkout++;
  }
  for (const inv of batch.invoices ?? []) {
    if (await openRiskForOverdueInvoice(inv.id, "reconciliation")) opened.overdue_receivable++;
  }

  console.log("\nwritten, then detected by the real pipeline");
  console.log(`  failed_payment      ${opened.failed_payment}`);
  console.log(`  abandoned_checkout  ${opened.abandoned_checkout}`);
  console.log(`  overdue_receivable  ${opened.overdue_receivable}`);
  console.log("\nnext: npx tsx scripts/run-batch.ts --dry --budget 50\n");
}

void main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
