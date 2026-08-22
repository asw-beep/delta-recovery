import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { analyseDegradation, persistFindings, type ClusterFinding } from "./degradation";
import { openRiskItems } from "./detect";
import { candidateActions, expectedValue, rankActions, type Action } from "./ev";
import { contactsInWindow, executeAction, isExecutable, remainingLiveBudget, type ExecMode } from "./executor";
import { downtimeOpenFor } from "./normalise";
import { DEFAULT_POLICY, evaluate, type PolicyContext, type RiskClass } from "./policy";
import { tryClassify } from "./taxonomy";
import { score as scoreUplift } from "./uplift";

/**
 * One batch of recovery work: score, rank, bound, decide, execute.
 *
 * The ordering is the product. Items are ranked by expected incremental value
 * and then cut at the contact budget, because a merchant cannot contact
 * everyone — DND windows, SMS spend and agent capacity all bind. Ranking by
 * ticket size or by "most likely to pay" both spend the budget on customers who
 * would have paid anyway; see eval/results.json.
 *
 * Every item that gets a decision produces a row whether or not anything
 * executes, so a STOP is as auditable as a send.
 */

export interface BatchOptions {
  /** How many contacts this run may make. The bound that makes ranking matter. */
  contactBudget: number;
  /** Cap on real Razorpay calls; the remainder execute as SIM and are labelled. */
  liveBudget?: number;
  dryRun?: boolean;
  now?: Date;
}

export interface BatchSummary {
  batchId: string;
  considered: number;
  degradation: { clusters: number; deferredItems: number; llmUsed: boolean; findings: ClusterFinding[] };
  decisions: Record<string, number>;
  executed: { live: number; sim: number; failed: number; duplicate: number; abortedSettled: number };
  contactBudget: number;
  liveBudgetUsed: number;
  amountTargetedPaise: number;
  blockedByRule: Record<string, number>;
}

export async function runBatch(opts: BatchOptions): Promise<BatchSummary> {
  const now = opts.now ?? new Date();
  const batchId = crypto.randomUUID();
  const items = await openRiskItems(500);

  // Root-cause pass BEFORE any decision. If a cluster of failures shares an
  // infrastructure cause and the evidence corroborates it, those items are
  // deferred as a group rather than each being contacted into an outage.
  const degradation = await analyseDegradation(6);
  if (degradation.findings.length > 0) await persistFindings(degradation.findings);
  const deferReason = new Map<string, { clusterId: string; reason: string }>();
  for (const f of degradation.findings) {
    if (f.disposition !== "DEFER_UNTIL_RESOLVED") continue;
    for (const id of f.riskItemIds) {
      deferReason.set(id, { clusterId: f.id, reason: f.rationale.slice(0, 200) });
    }
  }

  // ── 1. Score every open item ────────────────────────────────────────────
  const scored = [];
  for (const it of items) {
    const cls = it.class as RiskClass;
    let uplift: number | null = null;
    let contributions: Record<string, number> = {};
    let modelVersion = "unavailable";

    try {
      const s = scoreUplift({
        amountPaise: it.amountAtRiskPaise,
        riskClass: cls,
        taxonomyClass: taxonomyFor(cls, it.errorReason),
        method: it.method,
        hoursSinceEvent: (now.getTime() - it.detectedAt.getTime()) / 3_600_000,
        hour: now.getUTCHours(),
        weekday: now.getUTCDay(),
        daysToPayday: 15,
        downtimeActive: false,
        custSuccessCount: 0,
        custFailureCount: 0,
        custTenureDays: 180,
        ltvBand: 1,
        priorContacts7d: it.customerId ? await contactsInWindow(it.customerId) : 0,
      });
      uplift = s.uplift;
      contributions = s.contributions;
      modelVersion = s.modelVersion;
    } catch {
      // Leave uplift null. The policy engine escalates rather than guessing.
    }

    const actions = candidateActions(cls);
    const best = uplift === null ? null : rankActions(actions, uplift, it.amountAtRiskPaise)[0];

    scored.push({ item: it, cls, uplift, contributions, modelVersion, best });
  }

  // ── 2. Rank by expected incremental value, then cut at the budget ────────
  scored.sort((a, b) => (b.best?.ev.netPaise ?? -Infinity) - (a.best?.ev.netPaise ?? -Infinity));

  let contactsRemaining = opts.contactBudget;
  let liveRemaining = opts.liveBudget ?? (await remainingLiveBudget());

  const summary: BatchSummary = {
    batchId,
    considered: scored.length,
    degradation: {
      clusters: degradation.findings.length,
      deferredItems: degradation.deferredRiskItemIds.size,
      llmUsed: degradation.llmUsed,
      findings: degradation.findings,
    },
    decisions: {},
    executed: { live: 0, sim: 0, failed: 0, duplicate: 0, abortedSettled: 0 },
    contactBudget: opts.contactBudget,
    liveBudgetUsed: 0,
    amountTargetedPaise: 0,
    blockedByRule: {},
  };

  for (const s of scored) {
    const it = s.item;
    const action: Action = s.best?.action ?? "ESCALATE_HUMAN";
    const ev = s.uplift === null ? null : expectedValue({ uplift: s.uplift, amountPaise: it.amountAtRiskPaise, action });

    // Beyond the budget, the honest verdict is not STOP — it is "we ran out of
    // permitted contacts". Recorded as DEFER so the queue is truthful.
    const outOfBudget = contactsRemaining <= 0;

    const ctx: PolicyContext = {
      riskClass: s.cls,
      action,
      amountPaise: it.amountAtRiskPaise,
      taxonomyClass: taxonomyFor(s.cls, it.errorReason),
      uplift: s.uplift,
      netEvPaise: ev?.netPaise ?? null,
      detectedAt: it.detectedAt,
      now,
      customerOptedOut: await optedOut(it.customerId),
      alreadySettled: false,
      duplicateAction: false,
      contactsInWindow7d: it.customerId ? await contactsInWindow(it.customerId) : 0,
      actionsOnItem: await actionsOnItem(it.id),
      downtimeOpen: await downtimeOpenFor(it.method),
      spendTodayPaise: 0,
      degradationDeferred: deferReason.get(it.id),
    };

    const decision = outOfBudget
      ? {
          verdict: "DELAY" as const,
          reasons: [`Contact budget of ${opts.contactBudget} exhausted for this run`],
          policyVersion: DEFAULT_POLICY ? "1.0.0" : "1.0.0",
        }
      : evaluate(ctx);

    summary.decisions[decision.verdict] = (summary.decisions[decision.verdict] ?? 0) + 1;
    if (decision.verdict !== "ALLOW") {
      const rule = decision.reasons[0] ?? "unknown";
      summary.blockedByRule[rule] = (summary.blockedByRule[rule] ?? 0) + 1;
    }

    const [scoreRow] = s.uplift === null
      ? [undefined]
      : await db()
          .insert(schema.scores)
          .values({
            riskItemId: it.id,
            pRecoverDoNothing: 0,
            pRecoverContact: 0,
            uplift: s.uplift,
            modelVersion: s.modelVersion,
            features: {},
            contributions: s.contributions,
          })
          .returning({ id: schema.scores.id });

    const [decisionRow] = await db()
      .insert(schema.decisions)
      .values({
        riskItemId: it.id,
        scoreId: scoreRow?.id ?? null,
        proposedAction: action,
        expectedValuePaise: ev?.netPaise ?? 0,
        actionCostPaise: ev?.costPaise ?? 0,
        verdict: decision.verdict,
        verdictReasons: decision.reasons,
        policyVersion: decision.policyVersion,
        deferredUntil: "deferredUntil" in decision ? decision.deferredUntil ?? null : null,
        batchId,
      })
      .returning({ id: schema.decisions.id });

    if (decision.verdict === "ESCALATE") {
      await db().insert(schema.escalations).values({
        riskItemId: it.id,
        decisionId: decisionRow.id,
        reason: decision.reasons[0] ?? "escalated",
      });
    }

    if (decision.verdict !== "ALLOW" || opts.dryRun) continue;

    // Belt and braces: the ranking should never surface a non-outward action as
    // the winner, but if it ever did, nothing may be sent.
    if (!isExecutable(action)) {
      summary.decisions.ALLOW = (summary.decisions.ALLOW ?? 1) - 1;
      summary.decisions.STOP = (summary.decisions.STOP ?? 0) + 1;
      continue;
    }

    // Real calls are spent on the highest-value items first; the rest are
    // simulated and labelled, never presented as real.
    const mode: ExecMode = liveRemaining > 0 ? "live" : "sim";

    const res = await executeAction({
      decisionId: decisionRow.id,
      riskItemId: it.id,
      riskClass: s.cls,
      action,
      attemptNo: ctx.actionsOnItem + 1,
      sourceEntityId: it.sourceEntityId,
      sourceEntityType: it.sourceEntityType as "payment" | "order" | "invoice",
      amountPaise: it.amountAtRiskPaise,
      customerId: it.customerId,
      customer: await customerContact(it.customerId),
      mode,
    });

    if (res.status === "succeeded") {
      contactsRemaining--;
      summary.amountTargetedPaise += it.amountAtRiskPaise;
      if (mode === "live") {
        liveRemaining--;
        summary.liveBudgetUsed++;
        summary.executed.live++;
      } else {
        summary.executed.sim++;
      }
      await db()
        .update(schema.riskItems)
        .set({ state: "in_progress" })
        .where(eq(schema.riskItems.id, it.id));
    } else if (res.status === "skipped_duplicate") {
      summary.executed.duplicate++;
    } else if (res.status === "aborted_settled") {
      summary.executed.abortedSettled++;
    } else {
      summary.executed.failed++;
    }
  }

  return summary;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function taxonomyFor(cls: RiskClass, errorReason: string | null) {
  if (cls === "abandoned_checkout") return "ABANDONED" as never;
  if (cls === "overdue_receivable") return "RECEIVABLE" as never;
  if (!errorReason) return null;
  // Deterministic mapping; unmapped reasons surface rather than defaulting.
  const r = tryClassify(errorReason);
  return r.ok ? r.class : null;
}

async function optedOut(customerId: string | null): Promise<boolean> {
  if (!customerId) return false;
  const [c] = await db()
    .select({ optedOutAt: schema.customers.optedOutAt })
    .from(schema.customers)
    .where(eq(schema.customers.id, customerId));
  return Boolean(c?.optedOutAt);
}

async function actionsOnItem(riskItemId: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.actionAttempts)
    .innerJoin(schema.decisions, eq(schema.decisions.id, schema.actionAttempts.decisionId))
    .where(
      and(
        eq(schema.decisions.riskItemId, riskItemId),
        eq(schema.actionAttempts.status, "succeeded"),
      ),
    );
  return row?.n ?? 0;
}

async function customerContact(customerId: string | null) {
  if (!customerId) return {};
  const [c] = await db()
    .select({
      name: schema.customers.name,
      email: schema.customers.email,
      contact: schema.customers.contact,
    })
    .from(schema.customers)
    .where(eq(schema.customers.id, customerId));
  return c ?? {};
}

/**
 * Attributes an incoming payment back to the decision that caused it.
 *
 * `notes.decision_id` was written onto the payment link at creation, so a
 * `payment_link.paid` event carries it home. Without this the recovered figure
 * would be a guess, and "measured money recovered" is the track's actual bar.
 */
export async function attributeRecovery(
  notes: Record<string, unknown> | undefined,
  amountPaise: number,
  source: string,
  verifyingEventId: string | null,
): Promise<boolean> {
  const decisionId = typeof notes?.decision_id === "string" ? notes.decision_id : null;
  if (!decisionId) return false;

  const [d] = await db()
    .select({ riskItemId: schema.decisions.riskItemId })
    .from(schema.decisions)
    .where(eq(schema.decisions.id, decisionId));
  if (!d) return false;

  await db()
    .insert(schema.outcomes)
    .values({
      decisionId,
      riskItemId: d.riskItemId,
      result: "recovered",
      recoveredAmountPaise: amountPaise,
      recoveredAt: new Date(),
      attributionSource: source,
      verifyingEventId,
    })
    .onConflictDoNothing({ target: schema.outcomes.decisionId });

  await db()
    .update(schema.riskItems)
    .set({
      state: "recovered",
      closedAt: new Date(),
      closedReason: "recovered_after_intervention",
    })
    .where(eq(schema.riskItems.id, d.riskItemId));

  return true;
}

/** Items awaiting an outcome, for the queue view. */
export async function inFlightDecisions(limit = 100) {
  return db()
    .select({
      decisionId: schema.decisions.id,
      riskItemId: schema.decisions.riskItemId,
      action: schema.decisions.proposedAction,
      verdict: schema.decisions.verdict,
      evPaise: schema.decisions.expectedValuePaise,
      decidedAt: schema.decisions.decidedAt,
      mode: schema.actionAttempts.mode,
      shortUrl: schema.actionAttempts.shortUrl,
    })
    .from(schema.decisions)
    .leftJoin(schema.actionAttempts, eq(schema.actionAttempts.decisionId, schema.decisions.id))
    .leftJoin(schema.outcomes, eq(schema.outcomes.decisionId, schema.decisions.id))
    .where(isNull(schema.outcomes.id))
    .orderBy(desc(schema.decisions.decidedAt))
    .limit(limit);
}
