import { validateWebhookSignature } from "razorpay/dist/utils/razorpay-utils";
import { createHash } from "node:crypto";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";

/** The Razorpay SDK needs Node crypto, not the edge runtime. */
export const runtime = "nodejs";

/**
 * Razorpay webhook receiver.
 *
 * Contract (DECISIONS.md §3): return 2xx within 5 seconds or Razorpay retries with
 * backoff for 24h and then deactivates the endpoint. So this handler does the
 * absolute minimum — verify, persist raw, acknowledge. All interpretation
 * happens later, off this request.
 *
 * Duplicate delivery is a no-op via the unique index on razorpay_event_id, not
 * via application logic. Razorpay guarantees neither ordering nor exactly-once
 * delivery, so nothing downstream may assume either.
 */
export async function POST(request: Request) {
  // Raw body, unparsed — the HMAC is computed over these exact bytes. Parsing
  // first and re-serialising is the classic way to break signature verification.
  const raw = await request.text();

  const signature = request.headers.get("x-razorpay-signature");
  const eventId =
    request.headers.get("x-razorpay-event-id") ??
    // Razorpay normally sends the header; hash the body so we still dedupe if not.
    createHash("sha256").update(raw).digest("hex");

  if (!signature) {
    return Response.json({ error: "missing signature" }, { status: 400 });
  }

  let valid = false;
  try {
    valid = validateWebhookSignature(raw, signature, env().RAZORPAY_WEBHOOK_SECRET);
  } catch {
    valid = false;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "malformed payload" }, { status: 400 });
  }

  const event = typeof payload.event === "string" ? payload.event : "unknown";

  // Rejected deliveries are recorded too — a visible rejection is worth more in
  // the audit trail than a silent drop.
  await db()
    .insert(schema.webhookEvents)
    .values({ razorpayEventId: eventId, event, payload, signatureValid: valid })
    .onConflictDoNothing({ target: schema.webhookEvents.razorpayEventId });

  if (!valid) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  return Response.json({ ok: true });
}
