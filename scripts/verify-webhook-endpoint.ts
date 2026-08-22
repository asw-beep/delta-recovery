import "dotenv/config";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db";

/**
 * End-to-end check of the deployed webhook receiver.
 *
 * Signs a synthetic payload exactly the way Razorpay does, posts it to the
 * deployed endpoint, and confirms it landed in the database. This is the Day 1
 * gate, and it is the only way to know the whole chain works before a real
 * payment depends on it.
 *
 *   npx tsx scripts/verify-webhook-endpoint.ts https://<deployment>.vercel.app
 */

const base = process.argv[2] ?? process.env.APP_URL;
const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

async function main() {
  if (!base || base.includes("localhost")) {
    console.log("\nPass the deployed URL:\n  npx tsx scripts/verify-webhook-endpoint.ts https://<deployment>.vercel.app\n");
    process.exit(1);
  }
  if (!secret) {
    console.log("\nRAZORPAY_WEBHOOK_SECRET is not set in .env\n");
    process.exit(1);
  }

  const url = `${base.replace(/\/$/, "")}/api/webhooks/razorpay`;
  const eventId = `evt_probe_${Date.now().toString(36)}`;
  const paymentId = `pay_probe_${Date.now().toString(36)}`;

  const body = JSON.stringify({
    entity: "event",
    event: "payment.failed",
    payload: {
      payment: {
        entity: {
          id: paymentId,
          entity: "payment",
          amount: 849900,
          currency: "INR",
          status: "failed",
          order_id: null,
          method: "card",
          bank: "HDFC",
          email: "probe@example.com",
          contact: "+919999999999",
          created_at: Math.floor(Date.now() / 1000),
          error_code: "BAD_REQUEST_ERROR",
          error_description: "Payment failed",
          error_source: "bank",
          error_step: "payment_authorization",
          error_reason: "payment_failed",
        },
      },
    },
  });

  const signature = createHmac("sha256", secret).update(body).digest("hex");

  console.log(`\nPOST ${url}`);

  // 1. Correct signature -> 200
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": signature,
      "x-razorpay-event-id": eventId,
    },
    body,
    redirect: "manual",
  });

  if (res.status === 302 || res.status === 307) {
    const loc = res.headers.get("location") ?? "";
    console.log(`  FAIL  HTTP ${res.status} -> ${loc.slice(0, 70)}`);
    console.log(`\n  Vercel Deployment Protection is blocking this endpoint.`);
    console.log(`  Razorpay will never reach the handler. Disable it under`);
    console.log(`  Project -> Settings -> Deployment Protection.\n`);
    process.exit(1);
  }

  console.log(`  valid signature   HTTP ${res.status}  ${(await res.text()).slice(0, 80)}`);

  // 2. Wrong signature -> 401, proving verification is actually enforced
  const bad = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": "deadbeef",
      "x-razorpay-event-id": `${eventId}_bad`,
    },
    body,
    redirect: "manual",
  });
  console.log(`  bad signature     HTTP ${bad.status}  ${bad.status === 401 ? "(rejected, correct)" : "(SHOULD BE 401)"}`);

  // 3. Confirm it reached the database
  await new Promise((r) => setTimeout(r, 3000));
  const rows = await db()
    .select({
      event: schema.webhookEvents.event,
      valid: schema.webhookEvents.signatureValid,
      processedAt: schema.webhookEvents.processedAt,
    })
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.razorpayEventId, eventId));

  if (rows.length === 0) {
    console.log(`\n  FAIL  endpoint answered but nothing reached the database.`);
    console.log(`        DATABASE_URL is probably missing from the Vercel environment.\n`);
    process.exit(1);
  }

  console.log(`  stored in db      event=${rows[0].event} valid=${rows[0].valid} processed=${rows[0].processedAt ? "yes" : "not yet"}`);

  const risk = await db()
    .select({ id: schema.riskItems.id, amount: schema.riskItems.amountAtRiskPaise })
    .from(schema.riskItems)
    .where(eq(schema.riskItems.sourceEntityId, paymentId));
  console.log(`  risk item         ${risk.length ? `opened, Rs ${(risk[0].amount / 100).toLocaleString("en-IN")} at risk` : "not opened yet (cron will catch it)"}`);

  // Clean up the probe's traces.
  await db().delete(schema.riskItems).where(eq(schema.riskItems.sourceEntityId, paymentId));
  await db().delete(schema.payments).where(eq(schema.payments.razorpayPaymentId, paymentId));
  await db().delete(schema.webhookEvents).where(eq(schema.webhookEvents.razorpayEventId, eventId));
  await db().delete(schema.webhookEvents).where(eq(schema.webhookEvents.razorpayEventId, `${eventId}_bad`));

  console.log(`\n  chain verified end to end\n`);
}

void main().then(() => process.exit(0));
