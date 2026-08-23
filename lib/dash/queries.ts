import "server-only";
import { connection } from "next/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ACTION_COSTS, PATIENCE_COST_PAISE } from "@/lib/ev";

/**
 * Read model for the dashboard.
 *
 * Two rules govern everything in this file, both from DECISIONS.md:
 *
 * 1. Every figure the UI renders resolves to rows in these queries. Nothing is
 *    computed in a component, and nothing is typed by hand.
 * 2. `connection()` runs before each query so the route is never prerendered at
 *    build time with stale money on it. These pages must show the database as
 *    it is right now.
 */

export interface Overview {
  atRisk: { paise: number; items: number };
  recovered: { paise: number; items: number };
  selfRecovered: { items: number };
  afterAction: { items: number };
  /** Direct channel spend — real rupees out. Patience is priced separately. */
  spend: { paise: number; contacts: number; patiencePaise: number };
  execution: { live: number; sim: number; failed: number; duplicate: number };
  openByClass: {
    class: string;
    openCount: number;
    openPaise: number;
    recoveredCount: number;
    recoveredPaise: number;
    selfRecovered: number;
    afterAction: number;
  }[];
  verdicts: { verdict: string; n: number }[];
  lastBatchAt: Date | null;
  escalationsOpen: number;
}

/** Bigint columns arrive as strings over the wire; money must never be NaN. */
function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v) || 0;
  return 0;
}

export async function getOverview(): Promise<Overview> {
  await connection();

  const [risk] = await db()
    .select({
      atRiskPaise: sql<string>`coalesce(sum(${schema.riskItems.amountAtRiskPaise})
        filter (where ${schema.riskItems.state} in ('open','in_progress')), 0)`,
      atRiskItems: sql<number>`count(*) filter (
        where ${schema.riskItems.state} in ('open','in_progress'))::int`,
      selfRecovered: sql<number>`count(*) filter (
        where ${schema.riskItems.closedReason} = 'self_recovered_without_intervention')::int`,
      afterAction: sql<number>`count(*) filter (
        where ${schema.riskItems.closedReason} = 'recovered_after_intervention')::int`,
    })
    .from(schema.riskItems);

  // Recovered money is read from outcomes, never from risk_items — an outcome
  // row exists only because a verified webhook proved it.
  const [rec] = await db()
    .select({
      paise: sql<string>`coalesce(sum(${schema.outcomes.recoveredAmountPaise}), 0)`,
      items: sql<number>`count(*)::int`,
    })
    .from(schema.outcomes)
    .where(eq(schema.outcomes.result, "recovered"));

  const attempts = await db()
    .select({
      action: schema.actionAttempts.action,
      mode: schema.actionAttempts.mode,
      status: schema.actionAttempts.status,
      n: sql<number>`count(*)::int`,
    })
    .from(schema.actionAttempts)
    .groupBy(schema.actionAttempts.action, schema.actionAttempts.mode, schema.actionAttempts.status);

  const execution = { live: 0, sim: 0, failed: 0, duplicate: 0 };
  let spendPaise = 0;
  let patiencePaise = 0;
  let contacts = 0;
  for (const a of attempts) {
    if (a.status === "succeeded") {
      const cost = ACTION_COSTS[a.action];
      contacts += a.n;
      spendPaise += (cost?.directPaise ?? 0) * a.n;
      if (cost?.consumesPatience) patiencePaise += PATIENCE_COST_PAISE * a.n;
      if (a.mode === "live") execution.live += a.n;
      else execution.sim += a.n;
    } else if (a.status === "failed") execution.failed += a.n;
    else if (a.status === "skipped_duplicate") execution.duplicate += a.n;
  }

  const openByClass = await db()
    .select({
      class: schema.riskItems.class,
      openCount: sql<number>`count(*) filter (where ${schema.riskItems.state} = 'open')::int`,
      openPaise: sql<string>`coalesce(sum(${schema.riskItems.amountAtRiskPaise})
        filter (where ${schema.riskItems.state} = 'open'), 0)`,
      recoveredCount: sql<number>`count(*) filter (where ${schema.riskItems.state} = 'recovered')::int`,
      recoveredPaise: sql<string>`coalesce(sum(${schema.riskItems.amountAtRiskPaise})
        filter (where ${schema.riskItems.state} = 'recovered'), 0)`,
      selfRecovered: sql<number>`count(*) filter (
        where ${schema.riskItems.closedReason} = 'self_recovered_without_intervention')::int`,
      afterAction: sql<number>`count(*) filter (
        where ${schema.riskItems.closedReason} = 'recovered_after_intervention')::int`,
    })
    .from(schema.riskItems)
    .groupBy(schema.riskItems.class);

  const verdicts = await db()
    .select({ verdict: schema.decisions.verdict, n: sql<number>`count(*)::int` })
    .from(schema.decisions)
    .groupBy(schema.decisions.verdict);

  const [last] = await db()
    .select({ at: schema.decisions.decidedAt })
    .from(schema.decisions)
    .orderBy(desc(schema.decisions.decidedAt))
    .limit(1);

  const [esc] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.escalations)
    .where(isNull(schema.escalations.resolvedAt));

  return {
    atRisk: { paise: num(risk?.atRiskPaise), items: risk?.atRiskItems ?? 0 },
    recovered: { paise: num(rec?.paise), items: rec?.items ?? 0 },
    selfRecovered: { items: risk?.selfRecovered ?? 0 },
    afterAction: { items: risk?.afterAction ?? 0 },
    spend: { paise: spendPaise, contacts, patiencePaise },
    execution,
    openByClass: openByClass.map((r) => ({
      ...r,
      openPaise: num(r.openPaise),
      recoveredPaise: num(r.recoveredPaise),
    })),
    verdicts,
    lastBatchAt: last?.at ?? null,
    escalationsOpen: esc?.n ?? 0,
  };
}

export interface QueueRow {
  riskItemId: string;
  class: string;
  state: string;
  sourceEntityId: string;
  amountPaise: number;
  detectedAt: Date;
  errorReason: string | null;
  customerEmail: string | null;
  decisionId: string | null;
  proposedAction: string | null;
  verdict: string | null;
  reasons: string[] | null;
  evPaise: number | null;
  costPaise: number | null;
  uplift: number | null;
  decidedAt: Date | null;
  mode: string | null;
  attemptStatus: string | null;
  shortUrl: string | null;
  recoveredPaise: number | null;
  /** Loaded from a synthetic batch rather than real Razorpay traffic. */
  synthetic: boolean;
}

/**
 * The queue, ordered the way the agent orders it: by expected incremental
 * value. Items with no decision yet sort last rather than being hidden.
 */
export async function getQueue(limit = 200): Promise<QueueRow[]> {
  await connection();

  // The newest decision per risk item. DISTINCT ON is the cheap way to do this
  // in Postgres and keeps the whole queue to a single round trip.
  const latest = db().$with("latest").as(
    db()
      .selectDistinctOn([schema.decisions.riskItemId], {
        riskItemId: schema.decisions.riskItemId,
        decisionId: schema.decisions.id,
        proposedAction: schema.decisions.proposedAction,
        verdict: schema.decisions.verdict,
        reasons: schema.decisions.verdictReasons,
        evPaise: schema.decisions.expectedValuePaise,
        costPaise: schema.decisions.actionCostPaise,
        decidedAt: schema.decisions.decidedAt,
        scoreId: schema.decisions.scoreId,
      })
      .from(schema.decisions)
      .orderBy(schema.decisions.riskItemId, desc(schema.decisions.decidedAt)),
  );

  const rows = await db()
    .with(latest)
    .select({
      riskItemId: schema.riskItems.id,
      class: schema.riskItems.class,
      state: schema.riskItems.state,
      sourceEntityId: schema.riskItems.sourceEntityId,
      amountPaise: schema.riskItems.amountAtRiskPaise,
      detectedAt: schema.riskItems.detectedAt,
      errorReason: schema.payments.errorReason,
      customerEmail: schema.customers.email,
      decisionId: latest.decisionId,
      proposedAction: latest.proposedAction,
      verdict: latest.verdict,
      reasons: latest.reasons,
      evPaise: latest.evPaise,
      costPaise: latest.costPaise,
      decidedAt: latest.decidedAt,
      uplift: schema.scores.uplift,
      mode: schema.actionAttempts.mode,
      attemptStatus: schema.actionAttempts.status,
      shortUrl: schema.actionAttempts.shortUrl,
      recoveredPaise: schema.outcomes.recoveredAmountPaise,
      synthetic: sql<boolean>`${schema.riskItems.sourceEntityId} like '%SYN%'`,
    })
    .from(schema.riskItems)
    .leftJoin(latest, eq(latest.riskItemId, schema.riskItems.id))
    .leftJoin(schema.scores, eq(schema.scores.id, latest.scoreId))
    .leftJoin(schema.customers, eq(schema.customers.id, schema.riskItems.customerId))
    .leftJoin(
      schema.payments,
      eq(schema.payments.razorpayPaymentId, schema.riskItems.sourceEntityId),
    )
    .leftJoin(schema.actionAttempts, eq(schema.actionAttempts.decisionId, latest.decisionId))
    .leftJoin(schema.outcomes, eq(schema.outcomes.decisionId, latest.decisionId))
    .orderBy(desc(latest.evPaise), desc(schema.riskItems.amountAtRiskPaise))
    .limit(limit);

  return rows as QueueRow[];
}

export interface DecisionDetail {
  decision: typeof schema.decisions.$inferSelect;
  riskItem: typeof schema.riskItems.$inferSelect;
  score: typeof schema.scores.$inferSelect | null;
  diagnosis: typeof schema.diagnoses.$inferSelect | null;
  attempts: (typeof schema.actionAttempts.$inferSelect)[];
  outcome: typeof schema.outcomes.$inferSelect | null;
  escalation: typeof schema.escalations.$inferSelect | null;
  customer: typeof schema.customers.$inferSelect | null;
  payment: typeof schema.payments.$inferSelect | null;
  siblings: { id: string; decidedAt: Date; verdict: string; action: string }[];
}

/** Everything behind one decision — the audit trail, assembled. */
export async function getDecision(id: string): Promise<DecisionDetail | null> {
  await connection();

  const [decision] = await db()
    .select()
    .from(schema.decisions)
    .where(eq(schema.decisions.id, id));
  if (!decision) return null;

  const [riskItem] = await db()
    .select()
    .from(schema.riskItems)
    .where(eq(schema.riskItems.id, decision.riskItemId));
  if (!riskItem) return null;

  const [score] = decision.scoreId
    ? await db().select().from(schema.scores).where(eq(schema.scores.id, decision.scoreId))
    : [];

  const [diagnosis] = await db()
    .select()
    .from(schema.diagnoses)
    .where(eq(schema.diagnoses.riskItemId, riskItem.id))
    .orderBy(desc(schema.diagnoses.createdAt))
    .limit(1);

  const attempts = await db()
    .select()
    .from(schema.actionAttempts)
    .where(eq(schema.actionAttempts.decisionId, id))
    .orderBy(schema.actionAttempts.startedAt);

  const [outcome] = await db()
    .select()
    .from(schema.outcomes)
    .where(eq(schema.outcomes.decisionId, id));

  const [escalation] = await db()
    .select()
    .from(schema.escalations)
    .where(eq(schema.escalations.decisionId, id));

  const [customer] = riskItem.customerId
    ? await db().select().from(schema.customers).where(eq(schema.customers.id, riskItem.customerId))
    : [];

  const [payment] = await db()
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.razorpayPaymentId, riskItem.sourceEntityId));

  const siblings = await db()
    .select({
      id: schema.decisions.id,
      decidedAt: schema.decisions.decidedAt,
      verdict: schema.decisions.verdict,
      action: schema.decisions.proposedAction,
    })
    .from(schema.decisions)
    .where(eq(schema.decisions.riskItemId, riskItem.id))
    .orderBy(desc(schema.decisions.decidedAt));

  return {
    decision,
    riskItem,
    score: score ?? null,
    diagnosis: diagnosis ?? null,
    attempts,
    outcome: outcome ?? null,
    escalation: escalation ?? null,
    customer: customer ?? null,
    payment: payment ?? null,
    siblings,
  };
}

export interface FeedRow {
  id: string;
  decidedAt: Date;
  verdict: string;
  action: string;
  evPaise: number;
  amountPaise: number;
  class: string;
  mode: string | null;
  reason: string | null;
  synthetic: boolean;
}

/** Most recent decisions, for the overview. A STOP is as visible as a send. */
export async function getRecentDecisions(limit = 8): Promise<FeedRow[]> {
  await connection();

  const rows = await db()
    .select({
      id: schema.decisions.id,
      decidedAt: schema.decisions.decidedAt,
      verdict: schema.decisions.verdict,
      action: schema.decisions.proposedAction,
      evPaise: schema.decisions.expectedValuePaise,
      reasons: schema.decisions.verdictReasons,
      amountPaise: schema.riskItems.amountAtRiskPaise,
      class: schema.riskItems.class,
      mode: schema.actionAttempts.mode,
      synthetic: sql<boolean>`${schema.riskItems.sourceEntityId} like '%SYN%'`,
    })
    .from(schema.decisions)
    .innerJoin(schema.riskItems, eq(schema.riskItems.id, schema.decisions.riskItemId))
    .leftJoin(schema.actionAttempts, eq(schema.actionAttempts.decisionId, schema.decisions.id))
    .orderBy(desc(schema.decisions.decidedAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    decidedAt: r.decidedAt,
    verdict: r.verdict,
    action: r.action,
    evPaise: r.evPaise,
    amountPaise: r.amountPaise,
    class: r.class,
    mode: r.mode,
    reason: r.reasons?.[0] ?? null,
    synthetic: Boolean(r.synthetic),
  }));
}

/**
 * How much of what is on screen is synthetic.
 *
 * Synthetic traffic is legitimate as pipeline input, and illegitimate the moment
 * it is mistakable for real Razorpay activity. The count drives a permanent
 * banner for the same reason the SIM badge exists: a screenshot of this
 * dashboard must never overstate what actually happened on the account.
 */
export async function syntheticShare(): Promise<{ synthetic: number; total: number }> {
  await connection();
  const [row] = await db()
    .select({
      synthetic: sql<number>`count(*) filter (where ${schema.riskItems.sourceEntityId} like '%SYN%')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(schema.riskItems);
  return { synthetic: row?.synthetic ?? 0, total: row?.total ?? 0 };
}

/** Whether any simulated action exists — drives the persistent SIM banner. */
export async function hasSimulatedActions(): Promise<boolean> {
  await connection();
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.actionAttempts)
    .where(and(eq(schema.actionAttempts.mode, "sim"), inArray(schema.actionAttempts.status, ["succeeded", "pending"])));
  return (row?.n ?? 0) > 0;
}
