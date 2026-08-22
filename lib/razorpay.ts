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
