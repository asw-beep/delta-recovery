import "dotenv/config";
import {
  openRiskForFailedPayment,
  sweepAbandonedCheckouts,
  sweepOverdueInvoices,
} from "../lib/detect";
import {
  closeResolvedDowntimes,
  upsertDowntime,
  upsertInvoice,
  upsertOrder,
  upsertPayment,
} from "../lib/normalise";
import { processPendingEvents } from "../lib/process";
import {
  PAGE_MAX,
  fetchDowntimes,
  fetchInvoices,
  fetchOrders,
  fetchPayments,
} from "../lib/razorpay";

/**
 * The reconciliation sweep, runnable from a terminal.
 *
 *   npx tsx scripts/reconcile.ts            # 24h lookback
 *   npx tsx scripts/reconcile.ts --hours 72
 *
 * Same work as `GET /api/cron/reconcile`, which Vercel Cron calls daily — the
 * Hobby plan will not schedule it more often, so a demo needs to trigger it by
 * hand. Running it here also avoids depending on CRON_SECRET being present in
 * whichever environment happens to be nearest.
 *
 * The sweep exists because webhooks are not sufficient: Razorpay does not fire
 * `payment.failed` when a payment fails during authorisation, and there is no
 * abandonment event at all — abandonment has to be inferred from ageing orders.
 */

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

async function main() {
  const lookbackHours = Number(arg("hours", "24"));
  const from = Math.floor(Date.now() / 1000) - lookbackHours * 3600;
  const started = Date.now();

  console.log(`\nreconciliation sweep · ${lookbackHours}h lookback\n`);

  const backlog = await processPendingEvents(100);
  if (backlog.processed > 0 || backlog.failed > 0) {
    console.log(
      `drained ${backlog.processed} webhook event(s), ${backlog.failed} failed, ` +
        `${backlog.risksOpened} risk(s) opened`,
    );
  }

  // ── Payments ─────────────────────────────────────────────────────────────
  let scannedPayments = 0;
  let failedSeen = 0;
  let openedFailedPayment = 0;
  for (let skip = 0; skip < 500; skip += PAGE_MAX) {
    const page = await fetchPayments({ from, count: PAGE_MAX, skip });
    if (page.length === 0) break;
    scannedPayments += page.length;
    for (const p of page) {
      await upsertPayment(p);
      if (p.status === "failed") {
        failedSeen++;
        if (await openRiskForFailedPayment(p.id, "reconciliation")) openedFailedPayment++;
      }
    }
    if (page.length < PAGE_MAX) break;
  }

  // ── Orders, then infer abandonment from what has aged past the dwell ──────
  let scannedOrders = 0;
  for (let skip = 0; skip < 500; skip += PAGE_MAX) {
    const page = await fetchOrders({ from, count: PAGE_MAX, skip });
    if (page.length === 0) break;
    scannedOrders += page.length;
    for (const o of page) {
      await upsertOrder(o);
      for (const p of o.payments ?? []) await upsertPayment(p);
    }
    if (page.length < PAGE_MAX) break;
  }
  const openedAbandoned = await sweepAbandonedCheckouts();

  // ── Invoices ─────────────────────────────────────────────────────────────
  let scannedInvoices = 0;
  for (let skip = 0; skip < 500; skip += PAGE_MAX) {
    const page = await fetchInvoices({ from, count: PAGE_MAX, skip });
    if (page.length === 0) break;
    scannedInvoices += page.length;
    for (const inv of page) await upsertInvoice(inv);
    if (page.length < PAGE_MAX) break;
  }
  const openedReceivable = await sweepOverdueInvoices();

  // ── Instrument health, for the downtime deferral rule ─────────────────────
  // The endpoint reports only what is down right now, so anything it has
  // stopped reporting has resolved and must be closed here — nothing else ever
  // sets `end`.
  const active = await fetchDowntimes();
  let downtimes = 0;
  for (const dt of active ?? []) {
    await upsertDowntime(dt);
    downtimes++;
  }
  const downtimesClosed = await closeResolvedDowntimes(active?.map((d) => d.id) ?? null);

  console.log(
    `scanned            ${scannedPayments} payments (${failedSeen} failed), ` +
      `${scannedOrders} orders, ${scannedInvoices} invoices`,
  );
  console.log("");
  console.log("opened by reconciliation — risks the webhook path never reported");
  console.log(`  failed_payment      ${openedFailedPayment}`);
  console.log(`  abandoned_checkout  ${openedAbandoned}`);
  console.log(`  overdue_receivable  ${openedReceivable}`);
  console.log(`  total               ${openedFailedPayment + openedAbandoned + openedReceivable}`);
  console.log(
    `\n${active === null ? "downtime fetch unavailable — left open" : `${downtimes} active downtime(s), ${downtimesClosed} closed as resolved`}` +
      ` · ${Date.now() - started}ms\n`,
  );
}

void main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
