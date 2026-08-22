import { openRiskForFailedPayment } from "@/lib/detect";
import { env } from "@/lib/env";
import { upsertDowntime, upsertOrder, upsertPayment } from "@/lib/normalise";
import { processPendingEvents } from "@/lib/process";
import { PAGE_MAX, fetchDowntimes, fetchOrder, fetchPayments } from "@/lib/razorpay";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Reconciliation sweep.
 *
 * This exists because webhooks are not sufficient. Razorpay documents that
 * `payment.failed` is not fired when a payment fails during authorisation
 * (DECISIONS.md §3), so webhook-only detection systematically undercounts. This
 * sweep polls the API directly and converges with the webhook path onto the same
 * risk items — the partial unique index guarantees they cannot double-open.
 *
 * Also drains any webhook events that `after()` failed to process.
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
  const drained = await processPendingEvents(100);

  // 2. Sweep payments straight from the API.
  let scanned = 0;
  let failedSeen = 0;
  let openedByReconciliation = 0;
  const seenOrders = new Set<string>();

  for (let skip = 0; skip < 500; skip += PAGE_MAX) {
    const page = await fetchPayments({ from, count: PAGE_MAX, skip });
    if (page.length === 0) break;
    scanned += page.length;

    for (const p of page) {
      // Orders first — payments reference them.
      if (p.order_id && !seenOrders.has(p.order_id)) {
        seenOrders.add(p.order_id);
        try {
          await upsertOrder(await fetchOrder(p.order_id));
        } catch {
          // A missing order must not stop the sweep.
        }
      }

      await upsertPayment(p);

      if (p.status === "failed") {
        failedSeen++;
        const opened = await openRiskForFailedPayment(p.id, "reconciliation");
        if (opened) openedByReconciliation++;
      }
    }

    if (page.length < PAGE_MAX) break;
  }

  // 3. Refresh instrument health for the deferral rule.
  let downtimes = 0;
  for (const dt of await fetchDowntimes()) {
    await upsertDowntime(dt);
    downtimes++;
  }

  return Response.json({
    ok: true,
    ms: Date.now() - startedAt,
    lookbackHours,
    webhookBacklog: drained,
    scanned,
    failedSeen,
    // The headline number: risks the webhook path never told us about.
    openedByReconciliation,
    downtimes,
  });
}
