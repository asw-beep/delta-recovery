import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import type { RzpInvoice, RzpOrder, RzpPayment } from "../lib/razorpay";

/**
 * Repairs two things a generator reliably gets wrong, deterministically.
 *
 *   npx tsx scripts/rebase-synthetic.ts <in.json> <out.json>
 *   npx tsx scripts/rebase-synthetic.ts <in.json> <out.json> --self-recovery 0.25
 *
 * 1. TIMESTAMPS. A model anchors "the last five days" to its own sense of now,
 *    so a batch generated today can land a year in the past. That does not break
 *    the pipeline — the 72h window rule and the hoursSinceEvent feature both key
 *    off detectedAt, when WE opened the item, not the payment's own clock — but
 *    a queue showing last year's dates beside live ones reads as fabricated,
 *    which is the one thing this data must never do.
 *
 *    The shift is a whole number of days, so hour-of-day survives exactly and an
 *    evening-weighted batch stays evening-weighted.
 *
 * 2. SELF-RECOVERY RATE. Generators under-produce this because it needs a
 *    failure and a success on the SAME order, and it is the one property that
 *    matters most: self-recovery is the thesis. A batch without enough of it
 *    makes Delta look like every other dunning tool.
 *
 * Everything it adds obeys the same rules the loader enforces — SYN ids,
 * synthetic notes, taxonomy-mapped reasons — so the output re-validates.
 */

const DAY = 86400;

/** Reasons a customer plausibly hits before succeeding on the same order. */
const RETRYABLE: { reason: string; code: string; source: string; step: string; desc: string }[] = [
  { reason: "insufficient_funds", code: "BAD_REQUEST_ERROR", source: "customer", step: "payment_authorization",
    desc: "Your payment could not be completed due to insufficient account balance." },
  { reason: "incorrect_cvv", code: "BAD_REQUEST_ERROR", source: "customer", step: "payment_authentication",
    desc: "Your payment could not be completed due to an incorrect CVV." },
  { reason: "authentication_failed", code: "BAD_REQUEST_ERROR", source: "customer", step: "payment_authentication",
    desc: "Your payment could not be completed due to incorrect OTP or verification details." },
  { reason: "payment_timed_out", code: "GATEWAY_ERROR", source: "gateway", step: "payment_authentication",
    desc: "Your payment could not be completed due to a temporary issue. Try again later." },
  { reason: "gateway_technical_error", code: "GATEWAY_ERROR", source: "gateway", step: "payment_authorization",
    desc: "Your payment did not go through due to a temporary issue." },
  { reason: "payment_cancelled", code: "BAD_REQUEST_ERROR", source: "customer", step: "payment_authentication",
    desc: "Your payment has been cancelled. Try again or complete the payment later." },
];

interface Batch {
  _meta?: Record<string, unknown>;
  orders?: RzpOrder[];
  payments?: RzpPayment[];
  invoices?: RzpInvoice[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ist = (s: number) =>
  new Date(s * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });

async function main() {
  const [inFile, outFile] = process.argv.slice(2).filter((a) => a.endsWith(".json"));
  if (!inFile || !outFile) {
    console.error("usage: rebase-synthetic.ts <in.json> <out.json> [--self-recovery 0.25]");
    process.exit(1);
  }
  const target = Number(arg("self-recovery") ?? "0.25");
  const batch = JSON.parse(await readFile(inFile, "utf8")) as Batch;

  const orders = batch.orders ?? [];
  const payments = batch.payments ?? [];
  const invoices = batch.invoices ?? [];

  // ── 1. Re-anchor time ────────────────────────────────────────────────────
  const stamps = [
    ...orders.map((o) => o.created_at),
    ...payments.map((p) => p.created_at),
    ...invoices.flatMap((i) => [i.created_at, i.issued_at ?? 0, i.expire_by ?? 0].filter(Boolean)),
  ];
  const latest = Math.max(...stamps);
  const nowS = Math.floor(Date.now() / 1000);

  // Land the newest record a few hours back, rounded to whole days so
  // hour-of-day is preserved exactly.
  const shiftDays = Math.round((nowS - 4 * 3600 - latest) / DAY);
  const shift = shiftDays * DAY;

  const bump = <T extends { created_at: number }>(x: T) => {
    x.created_at += shift;
    return x;
  };
  orders.forEach(bump);
  payments.forEach(bump);
  invoices.forEach((i) => {
    bump(i);
    if (i.issued_at) i.issued_at += shift;
    if (i.expire_by) i.expire_by += shift;
  });

  console.log(`\nre-anchored by ${shiftDays} days (${(shiftDays / 365).toFixed(2)} years)`);
  console.log(`  earliest  ${ist(Math.min(...orders.concat().map((o) => o.created_at), ...payments.map((p) => p.created_at)))}`);
  console.log(`  latest    ${ist(latest + shift)}`);

  // Any invoice meant to be overdue must still be overdue after the shift.
  const stillFuture = invoices.filter(
    (i) => i.status === "issued" && i.amount_due > 0 && (i.expire_by ?? 0) * 1000 > Date.now(),
  );
  if (stillFuture.length > 0) {
    // Pull them back behind now so the receivables class still fires.
    for (const i of stillFuture) i.expire_by = nowS - 3 * DAY;
    console.log(`  pulled ${stillFuture.length} invoice due-date(s) back behind now`);
  }

  // ── 2. Top up self-recovery ──────────────────────────────────────────────
  const O = new Map(orders.map((o) => [o.id, o]));
  const failed = payments.filter((p) => p.status === "failed");
  const paidOrders = orders.filter((o) => o.status === "paid");
  const onPaid = failed.filter((p) => p.order_id && O.get(p.order_id)?.status === "paid");

  // Solve (onPaid + n) / (failed + n) = target  →  n = (target·F − P) / (1 − target)
  const need = Math.max(
    0,
    Math.ceil((target * failed.length - onPaid.length) / (1 - target)),
  );

  console.log(`\nself-recovery: ${onPaid.length}/${failed.length} = ${(onPaid.length / failed.length * 100).toFixed(1)}%`);
  if (need > 0 && paidOrders.length > 0) {
    let added = 0;
    let seq = 1;
    // Round-robin across paid orders so no single order looks pathological.
    for (let round = 0; added < need; round++) {
      for (const o of paidOrders) {
        if (added >= need) break;
        // Model the customer from a payment already on this order.
        const sibling =
          payments.find((p) => p.order_id === o.id && p.status === "failed") ??
          payments.find((p) => p.order_id === o.id);
        if (!sibling) continue;

        const r = RETRYABLE[(added + round) % RETRYABLE.length];
        // Sit the extra attempt before the sibling, a few minutes earlier each time.
        const at = sibling.created_at - (round + 1) * (7 * 60 + (added % 5) * 60);

        payments.push({
          id: `pay_SYNR${String(seq++).padStart(5, "0")}`,
          entity: "payment",
          amount: o.amount,
          currency: "INR",
          status: "failed",
          order_id: o.id,
          method: sibling.method,
          bank: sibling.bank ?? null,
          wallet: sibling.wallet ?? null,
          vpa: sibling.vpa ?? null,
          email: sibling.email,
          contact: sibling.contact,
          created_at: at,
          error_code: r.code,
          error_description: r.desc,
          error_source: r.source,
          error_step: r.step,
          error_reason: r.reason,
          notes: { synthetic: "true", note: "earlier attempt on an order that later succeeded" },
        } as RzpPayment);
        added++;
      }
      if (round > 20) break;
    }
    const nowFailed = payments.filter((p) => p.status === "failed").length;
    const nowOnPaid = payments.filter(
      (p) => p.status === "failed" && p.order_id && O.get(p.order_id)?.status === "paid",
    ).length;
    console.log(`  added ${added} earlier attempt(s) on orders that later succeeded`);
    console.log(`  now ${nowOnPaid}/${nowFailed} = ${(nowOnPaid / nowFailed * 100).toFixed(1)}%`);
  }

  batch._meta = {
    ...(batch._meta ?? {}),
    rebased_at: new Date().toISOString(),
    rebased_shift_days: shiftDays,
    self_recovery_target: target,
  };

  await writeFile(outFile, JSON.stringify(batch, null, 2));
  console.log(`\nwrote ${outFile}`);
  console.log(`  ${orders.length} orders · ${payments.length} payments · ${invoices.length} invoices\n`);
}

void main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
