import { and, eq, gte, sql } from "drizzle-orm";
import pLimit from "p-limit";
import pRetry from "p-retry";
import { db, schema } from "./db";
import { env } from "./env";
import type { Action } from "./ev";
import {
  cancelPaymentLink,
  createPaymentLink,
  fetchInvoice,
  fetchOrder,
  fetchPayment,
  findPaymentLinkByReference,
  notifyInvoice,
  notifyPaymentLink,
  type RzpPaymentLink,
} from "./razorpay";

/**
 * Executes an approved action against Razorpay.
 *
 * Everything here runs after the policy engine has said ALLOW. Three properties
 * matter more than anything else in this file:
 *
 *  1. IDEMPOTENCY. The attempt row is written BEFORE the outbound call, under a
 *     unique index. A crash between the write and the API response cannot
 *     produce a second payment link.
 *
 *  2. STATE FRESHNESS. We re-read the entity from Razorpay immediately before
 *     acting. A customer who paid thirty seconds ago must not receive a chase.
 *
 *  3. HONEST LABELLING. Test mode caps payment links, so part of any batch runs
 *     as SIM. Every attempt records which it was, and the UI never hides it.
 */

export type ExecMode = "live" | "sim";

export interface ExecuteInput {
  decisionId: string;
  riskItemId: string;
  riskClass: "failed_payment" | "abandoned_checkout" | "overdue_receivable";
  action: Action;
  attemptNo: number;
  sourceEntityId: string;
  sourceEntityType: "payment" | "order" | "invoice";
  amountPaise: number;
  customerId: string | null;
  customer: { name?: string | null; email?: string | null; contact?: string | null };
  mode: ExecMode;
}

export interface ExecuteResult {
  status: "succeeded" | "failed" | "skipped_duplicate" | "aborted_settled";
  attemptId?: string;
  razorpayEntityId?: string;
  shortUrl?: string;
  error?: string;
  mode: ExecMode;
}

/** Deterministic and stable across retries — this is the whole safety property. */
export function idempotencyKey(riskItemId: string, action: Action, attemptNo: number): string {
  return `${riskItemId}:${action}:${attemptNo}`;
}

/** <= 40 chars, unique per attempt, and carries no PII. */
function referenceId(riskItemId: string, attemptNo: number): string {
  return `dlt_${riskItemId.replace(/-/g, "").slice(0, 28)}_${attemptNo}`;
}

/**
 * Razorpay publishes no rate limit for core APIs but does return 429s, so we
 * stay deliberately well under whatever it is rather than discovering the
 * ceiling during a demo.
 */
const limit = pLimit(3);
const MIN_INTERVAL_MS = 120;
let lastCallAt = 0;

async function throttled<T>(fn: () => Promise<T>): Promise<T> {
  return limit(async () => {
    const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return pRetry(fn, {
      retries: 3,
      minTimeout: 400,
      factor: 2,
      randomize: true,
      shouldRetry: (e) => {
        const status = (e as { statusCode?: number })?.statusCode;
        // Retry only on rate limiting and server faults. A 400 means the request
        // is wrong and retrying it just wastes the budget.
        return status === 429 || (typeof status === "number" && status >= 500);
      },
    });
  });
}

/** Settled according to our own normalised store. Cheap, and never leaves the box. */
async function settledLocally(input: ExecuteInput): Promise<boolean> {
  if (input.sourceEntityType === "payment") {
    const [p] = await db()
      .select({ status: schema.payments.status, orderId: schema.payments.razorpayOrderId })
      .from(schema.payments)
      .where(eq(schema.payments.razorpayPaymentId, input.sourceEntityId));
    if (!p) return false;
    if (["captured", "authorized"].includes(p.status)) return true;
    if (p.orderId) {
      const [o] = await db()
        .select({ status: schema.orders.status })
        .from(schema.orders)
        .where(eq(schema.orders.razorpayOrderId, p.orderId));
      return o?.status === "paid";
    }
    return false;
  }
  if (input.sourceEntityType === "order") {
    const [o] = await db()
      .select({ status: schema.orders.status })
      .from(schema.orders)
      .where(eq(schema.orders.razorpayOrderId, input.sourceEntityId));
    return o?.status === "paid";
  }
  const [inv] = await db()
    .select({ status: schema.invoices.status, due: schema.invoices.amountDuePaise })
    .from(schema.invoices)
    .where(eq(schema.invoices.razorpayInvoiceId, input.sourceEntityId));
  return inv ? inv.status === "paid" || inv.due <= 0 : false;
}

/**
 * Has the money already arrived?
 *
 * Local state first — it is free and catches most cases. For LIVE execution we
 * then confirm against Razorpay, because our copy can lag a webhook by seconds
 * and those are exactly the seconds in which someone pays.
 *
 * SIM deliberately stops at the local check: a simulated action must make no
 * network call at all, or it is not a simulation.
 */
async function alreadySettled(input: ExecuteInput): Promise<boolean> {
  if (await settledLocally(input)) return true;
  if (input.mode === "sim") return false;

  try {
    if (input.sourceEntityType === "payment") {
      const p = await throttled(() => fetchPayment(input.sourceEntityId));
      if (["captured", "authorized"].includes(p.status)) return true;
      if (p.order_id) {
        return (await throttled(() => fetchOrder(p.order_id!))).status === "paid";
      }
      return false;
    }
    if (input.sourceEntityType === "order") {
      return (await throttled(() => fetchOrder(input.sourceEntityId))).status === "paid";
    }
    const inv = await throttled(() => fetchInvoice(input.sourceEntityId));
    return inv.status === "paid" || inv.amount_due <= 0;
  } catch {
    // If we cannot confirm, do not act. Failing closed is right when the
    // alternative is chasing someone who has already paid.
    return true;
  }
}

export async function executeAction(input: ExecuteInput): Promise<ExecuteResult> {
  const key = idempotencyKey(input.riskItemId, input.action, input.attemptNo);

  // ── 1. Claim the attempt BEFORE doing anything observable ────────────────
  const [claimed] = await db()
    .insert(schema.actionAttempts)
    .values({
      decisionId: input.decisionId,
      idempotencyKey: key,
      attemptNo: input.attemptNo,
      action: input.action,
      mode: input.mode,
      status: "pending",
      referenceId: referenceId(input.riskItemId, input.attemptNo),
    })
    .onConflictDoNothing({ target: schema.actionAttempts.idempotencyKey })
    .returning({ id: schema.actionAttempts.id });

  if (!claimed) {
    return { status: "skipped_duplicate", mode: input.mode };
  }

  const finish = async (patch: Partial<typeof schema.actionAttempts.$inferInsert>) => {
    await db()
      .update(schema.actionAttempts)
      .set({ ...patch, completedAt: new Date() })
      .where(eq(schema.actionAttempts.id, claimed.id));
  };

  // ── 2. Refuse to act on money that has already arrived ───────────────────
  if (await alreadySettled(input)) {
    await finish({ status: "failed", error: "aborted: entity already settled" });
    return { status: "aborted_settled", attemptId: claimed.id, mode: input.mode };
  }

  // ── 3. Execute ───────────────────────────────────────────────────────────
  try {
    const outcome =
      input.mode === "sim"
        ? await simulate(input)
        : await performLive(input, referenceId(input.riskItemId, input.attemptNo));

    await finish({
      status: "succeeded",
      razorpayEntityId: outcome.entityId,
      shortUrl: outcome.shortUrl,
      request: outcome.request,
      response: outcome.response,
      httpStatus: 200,
    });

    // The fatigue cap reads this ledger, so SIM contacts must be recorded too —
    // otherwise a simulated batch would silently exempt itself from the rules.
    if (input.customerId && CONTACT_ACTIONS.includes(input.action)) {
      await db().insert(schema.contacts).values({
        customerId: input.customerId,
        decisionId: input.decisionId,
        channel: input.action === "NUDGE_EMAIL" ? "email" : "sms",
      });
    }

    return {
      status: "succeeded",
      attemptId: claimed.id,
      razorpayEntityId: outcome.entityId,
      shortUrl: outcome.shortUrl,
      mode: input.mode,
    };
  } catch (e) {
    const err = e as { statusCode?: number; error?: { description?: string } };
    const message = err?.error?.description ?? (e instanceof Error ? e.message : String(e));
    await finish({
      status: "failed",
      error: message.slice(0, 500),
      httpStatus: err?.statusCode ?? null,
    });
    return { status: "failed", attemptId: claimed.id, error: message, mode: input.mode };
  }
}

const CONTACT_ACTIONS: Action[] = ["NUDGE_SMS", "NUDGE_EMAIL", "CHASE_INVOICE"];

interface Outcome {
  entityId?: string;
  shortUrl?: string;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}

/**
 * Actions that are allowed to reach Razorpay at all.
 *
 * STOP, DEFER and ESCALATE_HUMAN are decisions, not outward actions — they must
 * never produce an API call. This list is a hard gate rather than a convention,
 * because a STOP that quietly sends a payment link would violate the single
 * promise the whole product makes.
 */
const EXECUTABLE_ACTIONS: readonly Action[] = [
  "ISSUE_RECOVERY_LINK",
  "NUDGE_SMS",
  "NUDGE_EMAIL",
  "CHASE_INVOICE",
  "WITHDRAW",
];

export function isExecutable(action: Action): boolean {
  return EXECUTABLE_ACTIONS.includes(action);
}

async function performLive(input: ExecuteInput, refId: string): Promise<Outcome> {
  if (!isExecutable(input.action)) {
    throw new Error(
      `${input.action} is a decision, not an outward action — refusing to contact anyone`,
    );
  }

  // Receivables re-notify the invoice that already exists. No payment link is
  // minted, so this consumes none of the test-mode link budget.
  if (input.action === "CHASE_INVOICE") {
    const inv = await throttled(() => fetchInvoice(input.sourceEntityId));
    if (!["issued", "partially_paid"].includes(inv.status)) {
      throw new Error(`invoice is ${inv.status}; notify_by requires issued or partially_paid`);
    }
    await throttled(() => notifyInvoice(input.sourceEntityId, "email"));
    return {
      entityId: inv.id,
      shortUrl: inv.short_url ?? undefined,
      request: { invoice: inv.id, medium: "email" },
      response: { success: true },
    };
  }

  if (input.action === "WITHDRAW") {
    await throttled(() => cancelPaymentLink(input.sourceEntityId));
    return { entityId: input.sourceEntityId, request: { cancel: input.sourceEntityId }, response: { cancelled: true } };
  }

  // Failed payments and abandoned checkouts both get a fresh payment link,
  // because the original instrument cannot be re-presented.
  const params = {
    amountPaise: input.amountPaise,
    description: describe(input),
    referenceId: refId,
    expireBy: new Date(Date.now() + 72 * 3600_000),
    customer: input.customer,
    notes: {
      // The attribution key. `payment_link.paid` carries this back to us.
      decision_id: input.decisionId,
      risk_item_id: input.riskItemId,
      risk_class: input.riskClass,
    },
    notify: { sms: false, email: false },
  };

  let link: RzpPaymentLink;
  try {
    link = await throttled(() => createPaymentLink(params));
  } catch (e) {
    const err = e as { error?: { description?: string } };
    const desc = err?.error?.description ?? "";
    // A duplicate reference means a previous attempt got further than we knew.
    // Adopt that link rather than minting a second one.
    if (/reference id/i.test(desc)) {
      const existing = await throttled(() => findPaymentLinkByReference(refId));
      if (!existing) throw e;
      link = existing;
    } else {
      throw e;
    }
  }

  const medium = input.action === "NUDGE_EMAIL" ? "email" : "sms";
  await throttled(() => notifyPaymentLink(link.id, medium));

  return {
    entityId: link.id,
    shortUrl: link.short_url,
    request: params as unknown as Record<string, unknown>,
    response: { id: link.id, short_url: link.short_url, status: link.status, notified: medium },
  };
}

/**
 * Simulated execution. Touches no Razorpay endpoint and produces an obviously
 * fake identifier, so a SIM row can never be mistaken for a real transaction.
 */
async function simulate(input: ExecuteInput): Promise<Outcome> {
  if (!isExecutable(input.action)) {
    throw new Error(`${input.action} is a decision, not an outward action`);
  }
  const id = `SIM_${input.riskItemId.replace(/-/g, "").slice(0, 12)}_${input.attemptNo}`;
  return {
    entityId: id,
    shortUrl: undefined,
    request: { simulated: true, action: input.action, amountPaise: input.amountPaise },
    response: { simulated: true, id },
  };
}

function describe(input: ExecuteInput): string {
  const rupees = (input.amountPaise / 100).toLocaleString("en-IN");
  return input.riskClass === "abandoned_checkout"
    ? `Complete your order — Rs ${rupees}`
    : `Payment for your order — Rs ${rupees}`;
}

/**
 * How many live actions the batch may still take.
 *
 * Test mode caps payment links per business (DECISIONS.md §3), so the batch
 * spends a declared budget of real calls and simulates the rest. Receivables
 * are excluded from this count because they mint no link.
 */
export async function remainingLiveBudget(): Promise<number> {
  const cap = env().LIVE_ACTION_BUDGET;
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.actionAttempts)
    .where(
      and(
        eq(schema.actionAttempts.mode, "live"),
        eq(schema.actionAttempts.status, "succeeded"),
        sql`${schema.actionAttempts.action} <> 'CHASE_INVOICE'`,
      ),
    );
  return Math.max(0, cap - (row?.n ?? 0));
}

/** Contacts to this customer in the trailing 7 days — input to the fatigue cap. */
export async function contactsInWindow(customerId: string, days = 7): Promise<number> {
  const since = new Date(Date.now() - days * 86400_000);
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.customerId, customerId), gte(schema.contacts.sentAt, since)));
  return row?.n ?? 0;
}
