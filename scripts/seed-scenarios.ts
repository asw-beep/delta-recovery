import "dotenv/config";
import { rzp } from "../lib/razorpay";

/**
 * Creates the real Razorpay objects a demo needs in order to exercise paths
 * that the account's own traffic has not produced yet.
 *
 *   npx tsx scripts/seed-scenarios.ts
 *
 * Nothing here fabricates a risk item or a decision. It creates genuine orders
 * and payment links on the test account; detection, scoring and policy then run
 * over them exactly as they would over organic traffic. That distinction is the
 * whole reason this script creates Razorpay objects rather than database rows.
 *
 * Two thresholds are deliberately NOT worked around:
 *
 *   - an unpaid order is only abandoned after ABANDON_DWELL_HOURS (2h)
 *   - an invoice is only overdue after its due date
 *
 * Both are the precision of the detector, so the orders created here become
 * abandoned-checkout risk items on their own schedule rather than immediately.
 * Invoices are not seeded at all: Razorpay will not accept a past `expire_by`,
 * and the 15-day grace cannot be backdated, so a same-day overdue receivable
 * cannot be produced honestly.
 */

/**
 * Amounts are in paise. The high-value policy rule fires at 2_500_000 paise
 * (Rs 25,000), so anything meant to ESCALATE must exceed that — a distinction
 * worth spelling out, because Rs 3,249 and Rs 32,490 differ by one underscore.
 */
const HIGH_VALUE_PAISE = 2_500_000;

const AMOUNTS = [
  { paise: 3_249_000, note: "Rs 32,490 — above the high-value rule, expect ESCALATE" },
  { paise: 4_150_000, note: "Rs 41,500 — second escalation candidate" },
  { paise: 189_900, note: "Rs 1,899 — ordinary, expect a normal EV decision" },
  { paise: 74_900, note: "Rs 749 — small, likely below the EV floor" },
];

const CONTACTS = [
  { name: "Priya Nair", email: "priya.nair@example.com", contact: "+919845012345" },
  { name: "Rohit Menon", email: "rohit.menon@example.com", contact: "+919845067890" },
  { name: "Anjali Rao", email: "anjali.rao@example.com", contact: "+919845054321" },
  { name: "Vikram Shah", email: "vikram.shah@example.com", contact: "+919845098765" },
];

function rupees(paise: number) {
  return `Rs ${(paise / 100).toLocaleString("en-IN")}`;
}

async function main() {
  const wantLink = process.argv.includes("--link");
  const r = rzp() as unknown as {
    orders: { create: (o: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };

  console.log("\nseeding real Razorpay objects\n");

  // ── Orders ───────────────────────────────────────────────────────────────
  // These consume none of the test-mode payment-link budget. Left unpaid they
  // become abandoned-checkout risk items once they pass the dwell threshold.
  console.log("orders (become abandoned_checkout after the 2h dwell)");
  for (let i = 0; i < AMOUNTS.length; i++) {
    const a = AMOUNTS[i];
    const c = CONTACTS[i % CONTACTS.length];
    const flag = a.paise >= HIGH_VALUE_PAISE ? " [high value]" : "";
    const order = await r.orders.create({
      amount: a.paise,
      currency: "INR",
      receipt: `delta_seed_${Date.now()}_${i}`,
      notes: {
        seeded_by: "seed-scenarios",
        customer_name: c.name,
        customer_email: c.email,
        customer_contact: c.contact,
      },
    });
    console.log(`  ${String(order.id).padEnd(22)} ${rupees(a.paise).padStart(12)}${flag}  ${a.note}`);
  }

  // ── A payment link to fail against ───────────────────────────────────────
  // A link stays payable after a failed attempt, so one link can generate
  // several genuine payment.failed events with different error reasons — which
  // is why this costs one unit of budget rather than one per failure.
  if (wantLink) {
    const { createPaymentLink } = await import("../lib/razorpay");
    const link = await createPaymentLink({
      amountPaise: 3_249_000,
      description: "Delta demo — high-value failure scenarios",
      referenceId: `delta_seed_hv_${Date.now()}`.slice(0, 40),
      expireBy: new Date(Date.now() + 72 * 3600_000),
      customer: CONTACTS[0],
      notes: { seeded_by: "seed-scenarios", purpose: "failure_scenarios" },
      notify: { sms: false, email: false },
    });
    console.log("\npayment link for generating failures (costs 1 of the ~30 budget)");
    console.log(`  ${link.short_url}   ${rupees(3_249_000)}`);
    console.log("\n  Pay it repeatedly with these cards to produce real failures:");
    console.log("    card_declined            4100 2800 0006 0003");
    console.log("    insufficient_fund        4100 2800 0008 0001");
    console.log("    gateway_technical_error  4100 2800 0002 0007");
    console.log("    payment_timed_out        4100 2800 0009 0000");
    console.log("  Random CVV, any future expiry, then choose FAILURE on the mock bank page.");
    console.log(`  Each failure opens a real risk item; at ${rupees(3_249_000)} the policy engine`);
    console.log("  should return ESCALATE on the high-value rule.");
  } else {
    console.log("\n(no payment link created — pass --link to create one)");
  }

  console.log("\nnext: npx tsx scripts/run-batch.ts --dry --budget 50\n");
}

void main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
