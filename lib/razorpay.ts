import Razorpay from "razorpay";
import { env } from "./env";

/**
 * Razorpay client and the narrow set of reads we actually use.
 *
 * Only endpoints verified against the official docs appear here. See
 * DECISIONS.md §3 — notably, there is no endpoint that re-attempts a failed
 * payment, so nothing of that shape exists in this file.
 */

let cached: Razorpay | null = null;

export function rzp(): Razorpay {
  if (!cached) {
    const e = env();
    cached = new Razorpay({ key_id: e.RAZORPAY_KEY_ID, key_secret: e.RAZORPAY_KEY_SECRET });
  }
  return cached;
}

/** The subset of Razorpay's payment entity we rely on. */
export interface RzpPayment {
  id: string;
  entity: "payment";
  amount: number; // paise
  currency: string;
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  order_id: string | null;
  method?: string;
  bank?: string | null;
  wallet?: string | null;
  vpa?: string | null;
  email?: string;
  contact?: string | number;
  customer_id?: string | null;
  created_at: number; // unix seconds
  error_code?: string | null;
  error_description?: string | null;
  error_source?: string | null;
  error_step?: string | null;
  error_reason?: string | null;
  notes?: Record<string, string> | unknown[];
}

export interface RzpOrder {
  id: string;
  entity: "order";
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string | null;
  status: "created" | "attempted" | "paid";
  attempts: number;
  created_at: number;
  notes?: Record<string, string> | unknown[];
}

export interface RzpInvoice {
  id: string;
  entity: "invoice";
  status: "draft" | "issued" | "partially_paid" | "paid" | "cancelled" | "expired" | "deleted";
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  short_url: string | null;
  customer_id?: string | null;
  customer_details?: { email?: string; contact?: string; name?: string };
  order_id?: string | null;
  expire_by: number | null;
  issued_at: number | null;
  created_at: number;
  notes?: Record<string, string> | unknown[];
}

export interface RzpDowntime {
  id: string;
  entity: "payment.downtime";
  method: string;
  begin: number;
  end: number | null;
  status: string;
  severity?: string;
  instrument?: Record<string, unknown>;
}

/** Razorpay caps `count` at 100. Callers paginate with `skip`. */
export const PAGE_MAX = 100;

export async function fetchPayments(opts: {
  from?: number;
  to?: number;
  count?: number;
  skip?: number;
}): Promise<RzpPayment[]> {
  const res = (await rzp().payments.all({
    count: Math.min(opts.count ?? PAGE_MAX, PAGE_MAX),
    skip: opts.skip ?? 0,
    ...(opts.from ? { from: opts.from } : {}),
    ...(opts.to ? { to: opts.to } : {}),
  })) as unknown as { items: RzpPayment[] };
  return res.items ?? [];
}

export async function fetchPayment(id: string): Promise<RzpPayment> {
  return (await rzp().payments.fetch(id)) as unknown as RzpPayment;
}

export async function fetchOrder(id: string): Promise<RzpOrder> {
  return (await rzp().orders.fetch(id)) as unknown as RzpOrder;
}

/**
 * Orders with their payment attempts expanded, for abandonment inference.
 *
 * `GET /v1/orders` has no `status` filter (DECISIONS.md §3), so we sweep by time
 * window and classify locally. `expand[]=payments` keeps that to one call per
 * page instead of one per order.
 */
export async function fetchOrders(opts: {
  from?: number;
  to?: number;
  count?: number;
  skip?: number;
}): Promise<Array<RzpOrder & { payments?: RzpPayment[] }>> {
  const res = (await rzp().orders.all({
    count: Math.min(opts.count ?? PAGE_MAX, PAGE_MAX),
    skip: opts.skip ?? 0,
    "expand[]": "payments",
    ...(opts.from ? { from: opts.from } : {}),
    ...(opts.to ? { to: opts.to } : {}),
  } as never)) as unknown as {
    items: Array<RzpOrder & { payments?: unknown }>;
  };

  // `expand[]=payments` does NOT return an array. It returns a Razorpay
  // collection — { entity: "collection", count, items: [...] } — so iterating
  // the field directly throws "object is not iterable". Unwrapping it here
  // means callers get the array the type promises, rather than each having to
  // know the shape.
  return (res.items ?? []).map((o) => ({
    ...o,
    payments: expandedPayments(o.payments),
  }));
}

/** Accepts either a bare array or a Razorpay collection; always returns an array. */
function expandedPayments(value: unknown): RzpPayment[] {
  if (Array.isArray(value)) return value as RzpPayment[];
  if (value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)) {
    return (value as { items: RzpPayment[] }).items;
  }
  return [];
}

export async function fetchInvoices(opts: {
  from?: number;
  to?: number;
  count?: number;
  skip?: number;
}): Promise<RzpInvoice[]> {
  const res = (await rzp().invoices.all({
    count: Math.min(opts.count ?? PAGE_MAX, PAGE_MAX),
    skip: opts.skip ?? 0,
    ...(opts.from ? { from: opts.from } : {}),
    ...(opts.to ? { to: opts.to } : {}),
  })) as unknown as { items: RzpInvoice[] };
  return res.items ?? [];
}

/**
 * Open instrument outages. Drives the deferral rule — we do not send a recovery
 * link into an ongoing outage, because the customer's next attempt fails too.
 */
export async function fetchDowntimes(): Promise<RzpDowntime[]> {
  try {
    const res = (await rzp().payments.fetchPaymentDowntime()) as unknown as {
      items?: RzpDowntime[];
    };
    return res.items ?? [];
  } catch {
    // Downtime reporting is best-effort; its absence must never block the loop.
    return [];
  }
}

// ─── Writes: the agent's entire action vocabulary ───────────────────────────
// Every endpoint here was verified against the official docs. Note what is
// absent: there is no re-charge of a failed payment, because no such endpoint
// exists (DECISIONS.md §3).

export interface RzpPaymentLink {
  id: string;
  short_url: string;
  status: string;
  reference_id?: string;
  amount: number;
}

export interface CreateLinkParams {
  amountPaise: number;
  description: string;
  referenceId: string;
  expireBy: Date;
  customer: { name?: string | null; email?: string | null; contact?: string | null };
  /** Carried through so `payment_link.paid` can be attributed back to a decision. */
  notes: Record<string, string>;
  notify?: { sms?: boolean; email?: boolean };
}

export async function createPaymentLink(p: CreateLinkParams): Promise<RzpPaymentLink> {
  return (await rzp().paymentLink.create({
    amount: p.amountPaise,
    currency: "INR",
    description: p.description.slice(0, 2048),
    reference_id: p.referenceId.slice(0, 40),
    expire_by: Math.floor(p.expireBy.getTime() / 1000),
    customer: {
      ...(p.customer.name ? { name: p.customer.name } : {}),
      ...(p.customer.email ? { email: p.customer.email } : {}),
      ...(p.customer.contact ? { contact: p.customer.contact } : {}),
    },
    notify: { sms: p.notify?.sms ?? false, email: p.notify?.email ?? false },
    reminder_enable: false,
    notes: p.notes,
  } as never)) as unknown as RzpPaymentLink;
}

/**
 * Razorpay has no idempotency keys on Payment Links, and rejects a duplicate
 * `reference_id` with an error rather than returning the original object. So on
 * that specific failure we look the existing link up instead of creating a
 * second one — which is what makes a mid-flight crash safe.
 */
export async function findPaymentLinkByReference(
  referenceId: string,
): Promise<RzpPaymentLink | null> {
  const res = (await rzp().paymentLink.all({ reference_id: referenceId } as never)) as unknown as {
    payment_links?: RzpPaymentLink[];
    items?: RzpPaymentLink[];
  };
  const items = res.payment_links ?? res.items ?? [];
  return items[0] ?? null;
}

export async function notifyPaymentLink(id: string, medium: "sms" | "email"): Promise<void> {
  await rzp().paymentLink.notifyBy(id, medium);
}

export async function cancelPaymentLink(id: string): Promise<void> {
  await rzp().paymentLink.cancel(id);
}

/**
 * Re-notify an existing invoice. Razorpay returns 400 unless the invoice is
 * `issued` or `partially_paid`, so callers must check state first.
 *
 * Note this consumes no payment-link budget — the invoice already exists.
 */
export async function notifyInvoice(id: string, medium: "sms" | "email"): Promise<void> {
  await rzp().invoices.notifyBy(id, medium);
}

export async function fetchInvoice(id: string): Promise<RzpInvoice> {
  return (await rzp().invoices.fetch(id)) as unknown as RzpInvoice;
}

/** Razorpay timestamps are unix seconds. */
export function tsToDate(seconds: number | null | undefined): Date | null {
  return seconds ? new Date(seconds * 1000) : null;
}

/** `notes` comes back as `[]` when empty, which is not a useful shape. */
export function notesToObject(
  notes: Record<string, string> | unknown[] | undefined,
): Record<string, unknown> {
  return notes && !Array.isArray(notes) ? notes : {};
}
