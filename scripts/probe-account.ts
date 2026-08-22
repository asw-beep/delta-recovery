import "dotenv/config";
import { rzp } from "../lib/razorpay";

/**
 * Empirical check of what this Razorpay test account can actually do.
 *
 * DECISIONS.md §3 records constraints read from the documentation. This asks
 * the account itself, because per-account product enablement is not something
 * the docs can tell us. Run before relying on any of it.
 *
 *   npx tsx scripts/probe-account.ts
 */

async function probe(label: string, fn: () => Promise<unknown>) {
  try {
    const res = (await fn()) as { items?: unknown[]; count?: number };
    const n = Array.isArray(res?.items) ? res.items.length : "?";
    console.log(`  AVAILABLE   ${label}  (${n} records)`);
    return res;
  } catch (e: unknown) {
    const err = e as { statusCode?: number; error?: { description?: string; code?: string } };
    const desc = err?.error?.description ?? (e instanceof Error ? e.message : String(e));
    console.log(`  UNAVAILABLE ${label}`);
    console.log(`              HTTP ${err?.statusCode ?? "?"} — ${String(desc).slice(0, 140)}`);
    return null;
  }
}

async function main() {
  const client = rzp();
  console.log("\nrazorpay test account probe\n");

  console.log("core");
  const payments = await probe("payments      ", () => client.payments.all({ count: 100 }));
  await probe("orders        ", () => client.orders.all({ count: 100 }));

  console.log("\nrecovery actions");
  const links = await probe("payment links ", () => client.paymentLink.all({}));
  await probe("invoices      ", () => client.invoices.all({ count: 100 }));

  console.log("\ndiagnosis inputs");
  await probe("downtimes     ", () => client.payments.fetchPaymentDowntime());

  // Payment-link headroom drives the LIVE/SIM split (DECISIONS.md §3).
  const used = Array.isArray((links as { items?: unknown[] } | null)?.items)
    ? (links as { items: unknown[] }).items.length
    : 0;
  console.log(`\npayment-link budget`);
  console.log(`  ${used} link(s) already exist in test mode.`);
  console.log(`  Documented cap is ~30 per business, so roughly ${Math.max(0, 30 - used)} remain.`);
  console.log(`  Reserve at least 15 for demo day.`);

  // Failed payments are the raw material for the whole product.
  const items = ((payments as { items?: Array<{ status: string }> } | null)?.items ?? []);
  const failed = items.filter((p) => p.status === "failed").length;
  console.log(`\ntest data`);
  console.log(`  ${items.length} payment(s) total, ${failed} failed.`);
  if (items.length === 0) {
    console.log(`  Nothing to detect yet — the account needs test payments before the`);
    console.log(`  dashboard shows anything real.`);
  }
  console.log("");
}

void main().then(() => process.exit(0));
