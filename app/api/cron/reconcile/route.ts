import {
  openRiskForFailedPayment,
  sweepAbandonedCheckouts,
  sweepOverdueInvoices,
} from "@/lib/detect";
import { env } from "@/lib/env";
import {
  closeResolvedDowntimes,
  upsertDowntime,
  upsertInvoice,
  upsertOrder,
  upsertPayment,
} from "@/lib/normalise";
import { processPendingEvents } from "@/lib/process";
import {
  PAGE_MAX,
  fetchDowntimes,
  fetchInvoices,
  fetchOrders,
  fetchPayments,
} from "@/lib/razorpay";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Reconciliation sweep across all three risk classes.
 *
 * This exists because webhooks are not sufficient. Razorpay documents that
 * `payment.failed` is not fired when a payment fails during authorisation
 * (DECISIONS.md §3), and there is no abandonment event at all — abandonment must
 * be inferred from ageing orders. The sweep polls the API directly and converges
 * with the webhook path onto the same risk items; the partial unique index
 * guarantees they cannot double-open.
 */
export async function GET(request: Request) {
  const secret = env().CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const startedAt = Date.now();
  const url = new URL(request.url);
  const lookbackHours = Number(url.searchParams.get("hours") ?? 24);
  const from = Math.floor(Date.now() / 1000) - lookbackHours * 3600;

  // 1. Drain anything the request-path processor missed.
  const webhookBacklog = await processPendingEvents(100);

  // 2. Payments — the failed-payment class.
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

  // 3. Orders — normalise first, then infer abandonment from what has aged.
  let scannedOrders = 0;
  for (let skip = 0; skip < 500; skip += PAGE_MAX) {
    const page = await fetchOrders({ from, count: PAGE_MAX, skip });
    if (page.length === 0) break;
    scannedOrders += page.length;

    for (const o of page) {
      await upsertOrder(o);
      // Expanded payments arrive with the order, so no extra call per order.
      for (const p of o.payments ?? []) await upsertPayment(p);
    }
    if (page.length < PAGE_MAX) break;
  }
  const openedAbandoned = await sweepAbandonedCheckouts();

  // 4. Invoices — the receivables class.
  let scannedInvoices = 0;
  for (let skip = 0; skip < 500; skip += PAGE_MAX) {
    const page = await fetchInvoices({ from, count: PAGE_MAX, skip });
    if (page.length === 0) break;
    scannedInvoices += page.length;
    for (const inv of page) await upsertInvoice(inv);
    if (page.length < PAGE_MAX) break;
  }
  const openedReceivable = await sweepOverdueInvoices();

  // 5. Instrument health, for the downtime deferral rule.
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

  return Response.json({
    ok: true,
    ms: Date.now() - startedAt,
    lookbackHours,
    webhookBacklog,
    scanned: {
      payments: scannedPayments,
      orders: scannedOrders,
      invoices: scannedInvoices,
      failedPaymentsSeen: failedSeen,
    },
    // The headline: risks the webhook path never told us about.
    openedByReconciliation: {
      failed_payment: openedFailedPayment,
      abandoned_checkout: openedAbandoned,
      overdue_receivable: openedReceivable,
      total: openedFailedPayment + openedAbandoned + openedReceivable,
    },
    downtimes,
    downtimesClosed,
  });
}
