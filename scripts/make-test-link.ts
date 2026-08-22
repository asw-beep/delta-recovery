import "dotenv/config";
import { inspect } from "node:util";
import { rzp } from "../lib/razorpay";

/**
 * Creates one real test-mode payment link, to drive a genuine Razorpay webhook.
 *
 * Consumes one of the ~30 test-mode payment links (DECISIONS.md §3), so use
 * sparingly and keep at least 15 in reserve for demo day.
 *
 *   npx tsx scripts/make-test-link.ts
 */
async function main() {
  const existing = (await rzp().paymentLink.all({})) as unknown as { items?: unknown[] };
  const used = existing.items?.length ?? 0;

  const link = (await rzp().paymentLink.create({
    amount: 849900,
    currency: "INR",
    description: "Delta webhook verification",
    reference_id: `verify_${Date.now().toString(36)}`,
    customer: { name: "Test Customer", email: "test@example.com", contact: "+919876543210" },
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes: { purpose: "webhook_verification" },
  })) as unknown as { id: string; short_url: string; status: string };

  console.log("");
  console.log(`  link    ${link.id}  (${link.status})`);
  console.log(`  amount  Rs 8,499`);
  console.log(`  budget  ${used + 1} of ~30 test links now used`);
  console.log("");
  console.log("  OPEN THIS AND DELIBERATELY FAIL THE PAYMENT:");
  console.log(`  ${link.short_url}`);
  console.log("");
  console.log("  Pay by card, then enter an OTP shorter than 4 digits to force a");
  console.log("  failure. That fires payment.failed, which is what we need to observe.");
  console.log("");
}

void main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    const err = e as { statusCode?: number; error?: Record<string, unknown> };
    console.error("");
    console.error("  payment link creation FAILED");
    console.error(`  HTTP ${err?.statusCode ?? "?"}`);
    console.error(`  ${inspect(err?.error ?? e, { depth: 4 }).slice(0, 700)}`);
    console.error("");
    process.exit(1);
  });
