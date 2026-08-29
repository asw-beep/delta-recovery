import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { analyseDegradation, persistFindings, type ClusterFinding } from "./degradation";
import { openRiskItems } from "./detect";
import { candidateActions, expectedValue, rankActions, type Action } from "./ev";
import {
  CONTACT_ACTIONS,
  executeAction,
  isExecutable,
  remainingLiveBudget,
  type ExecMode,
} from "./executor";
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
  /** Amount under ALLOW decisions this run intends to pursue. */
  amountTargetedPaise: number;
  /** Of that, the amount a contact actually went out for. */
  amountContactedPaise: number;
  blockedByRule: Record<string, number>;
}

export async function runBatch(opts: BatchOptions): Promise<BatchSummary> {
  const now = opts.now ?? new Date();
  const batchId = crypto.randomUUID();
  const items = await openRiskItems(500);

  // Every policy input below was once a query per item — opted-out, contacts in
  // window (twice), the parent chain, actions on that chain, open downtime. With
  // ~100 items against a pooler in ap-southeast-1 that is several hundred serial
  // round-trips and most of a two-minute batch, and it grew with volume. They are
  // all small bounded sets, so they are loaded once and kept current in memory.
  const pre = await loadPolicyInputs(items);

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
        priorContacts7d: it.customerId ? pre.contactsByCustomer.get(it.customerId) ?? 0 : 0,
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
    amountContactedPaise: 0,
    blockedByRule: {},
  };

  const pendingScores: Array<typeof schema.scores.$inferInsert> = [];
  const pendingDecisions: Array<typeof schema.decisions.$inferInsert> = [];
  const pendingEscalations: Array<typeof schema.escalations.$inferInsert> = [];

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
      customerOptedOut: Boolean(it.customerId && pre.optedOut.has(it.customerId)),
      alreadySettled: false,
      duplicateAction: false,
      contactsInWindow7d: it.customerId ? pre.contactsByCustomer.get(it.customerId) ?? 0 : 0,
      actionsOnItem: actionsOnChain(it.id, pre),
      downtimeOpenSince: (it.method ? pre.downtimeMethods.get(it.method) : null) ?? null,
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

    // The DECIDING reason is the last one: the policy engine accumulates
    // informational notes as it goes (an ignored stale downtime, for instance)
    // and pushes the verdict's own reason last. Taking reasons[0] attributes the
    // stop to whatever happened to be noted first, which is not why it stopped.
    const decidingReason = decision.reasons[decision.reasons.length - 1] ?? "unknown";

    summary.decisions[decision.verdict] = (summary.decisions[decision.verdict] ?? 0) + 1;
    if (decision.verdict !== "ALLOW") {
      summary.blockedByRule[decidingReason] = (summary.blockedByRule[decidingReason] ?? 0) + 1;
    }

    // Ids are minted here rather than by the database, so a row can be written
    // now or at the end of the batch without changing what refers to it.
    const scoreId = s.uplift === null ? null : crypto.randomUUID();
    const decisionId = crypto.randomUUID();

    const scoreValues =
      scoreId === null
        ? null
        : {
            id: scoreId,
            riskItemId: it.id,
            pRecoverDoNothing: 0,
            pRecoverContact: 0,
            uplift: s.uplift as number,
            modelVersion: s.modelVersion,
            features: {},
            contributions: s.contributions,
          };

    const decisionValues = {
      id: decisionId,
      riskItemId: it.id,
      scoreId,
      proposedAction: action,
      expectedValuePaise: ev?.netPaise ?? 0,
      actionCostPaise: ev?.costPaise ?? 0,
      verdict: decision.verdict,
      verdictReasons: decision.reasons,
      policyVersion: decision.policyVersion,
      deferredUntil: "deferredUntil" in decision ? decision.deferredUntil ?? null : null,
      batchId,
    };

    // Only an item that is about to execute needs its rows to exist right now —
    // `action_attempts` points at the decision, and the attempt row must be
    // written before the outbound call. Nothing reads the others until the batch
    // is over, so they go out in one statement each at the end instead of two
    // round-trips per item.
    const willExecute =
      decision.verdict === "ALLOW" && isExecutable(action) && !opts.dryRun;

    if (willExecute) {
      if (scoreValues) await db().insert(schema.scores).values(scoreValues);
      await db().insert(schema.decisions).values(decisionValues);
    } else {
      if (scoreValues) pendingScores.push(scoreValues);
      pendingDecisions.push(decisionValues);
    }

    if (decision.verdict === "ESCALATE" && !pre.openEscalations.has(it.id)) {
      // One open escalation per risk item. Re-running a batch — which a dry run
      // does routinely — must not hand the same case to a human twice: 13
      // escalations became 26 after two previews, and a queue that grows every
      // time someone looks at it is not a queue anyone can work.
      //
      // The set is marked here as well as read, so two items in one batch that
      // share a risk item cannot both queue a row before either is written.
      pre.openEscalations.add(it.id);
      pendingEscalations.push({
        riskItemId: it.id,
        decisionId,
        reason: decidingReason,
      });
    }

    if (decision.verdict !== "ALLOW") continue;

    // Belt and braces: the ranking should never surface a non-outward action as
    // the winner, but if it ever did, nothing may be sent. Checked before the
    // dry-run exit so a preview reports the same verdicts a live run would.
    if (!isExecutable(action)) {
      summary.decisions.ALLOW = (summary.decisions.ALLOW ?? 1) - 1;
      summary.decisions.STOP = (summary.decisions.STOP ?? 0) + 1;
      continue;
    }

    // Accrued on the decision, not on the send, so --dry states the money a
    // live run would go after instead of reporting zero.
    summary.amountTargetedPaise += it.amountAtRiskPaise;

    if (opts.dryRun) continue;

    // Real calls are spent on the highest-value items first; the rest are
    // simulated and labelled, never presented as real.
    const mode: ExecMode = liveRemaining > 0 ? "live" : "sim";

    const res = await executeAction({
      decisionId,
      riskItemId: it.id,
      riskClass: s.cls,
      action,
      attemptNo: ctx.actionsOnItem + 1,
      sourceEntityId: it.sourceEntityId,
      sourceEntityType: it.sourceEntityType as "payment" | "order" | "invoice",
      amountPaise: it.amountAtRiskPaise,
      customerId: it.customerId,
      customer: (it.customerId ? pre.customers.get(it.customerId) : undefined) ?? {},
      mode,
    });

    if (res.status === "succeeded") {
      // The caps have to keep binding INSIDE a run, not just between runs. These
      // two counters were previously re-read from the database on every item, so
      // a contact sent earlier in the batch was visible to later ones. Reading
      // them from a preloaded map without maintaining it here would silently
      // disarm the fatigue cap and the per-item action cap for a whole batch —
      // the exact failure mode already found twice in this codebase.
      if (it.customerId && CONTACT_ACTIONS.includes(action)) {
        pre.contactsByCustomer.set(
          it.customerId,
          (pre.contactsByCustomer.get(it.customerId) ?? 0) + 1,
        );
      }
      pre.succeededByItem.set(it.id, (pre.succeededByItem.get(it.id) ?? 0) + 1);

      contactsRemaining--;
      summary.amountContactedPaise += it.amountAtRiskPaise;
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

  // Foreign keys dictate the order: a decision points at its score, an
  // escalation at its decision.
  await insertChunked(schema.scores, pendingScores);
  await insertChunked(schema.decisions, pendingDecisions);
  await insertChunked(schema.escalations, pendingEscalations);

  return summary;
}

/**
 * Bulk insert, split so a large batch cannot exceed Postgres' bind-parameter
 * ceiling. Chunked rather than unbounded because the row count here scales with
 * open risk items, which is merchant-controlled.
 */
async function insertChunked<T extends { $inferInsert: object }>(
  table: T,
  rows: Array<T["$inferInsert"]>,
  size = 250,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    if (chunk.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db().insert(table as any).values(chunk as any);
    }
  }
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

/** Trailing window for the fatigue cap, in days. Mirrors `contactsInWindow`. */
const CONTACT_WINDOW_DAYS = 7;

/** How far the parent chain is walked before we assume the data is cyclic. */
const MAX_CHAIN_HOPS = 10;

interface PolicyInputs {
  /** Customers who have opted out. */
  optedOut: Set<string>;
  /** Contacts per customer in the trailing window. Maintained during the run. */
  contactsByCustomer: Map<string, number>;
  /**
   * Instrument -> when its MOST RECENT open downtime began.
   *
   * Most recent, not oldest: the policy engine judges staleness from this, and
   * a years-old stuck record must not mask a genuine outage that started an
   * hour ago on the same method.
   */
  downtimeMethods: Map<string, Date>;
  /** risk item -> its parent, for walking a pursuit back to the first failure. */
  parentOf: Map<string, string | null>;
  /** Succeeded attempts per risk item. Maintained during the run. */
  succeededByItem: Map<string, number>;
  customers: Map<string, { name: string | null; email: string | null; contact: string | null }>;
  /** Risk items that already have an unresolved escalation. */
  openEscalations: Set<string>;
}

/**
 * Loads every policy input for the whole batch in one round of queries.
 *
 * These are deliberately unfiltered by item where the table is small — the
 * parent map and the open-downtime list are a few hundred rows at most, and one
 * query for all of them beats a bounded query per item by two orders of
 * magnitude on a pooled connection.
 */
async function loadPolicyInputs(
  items: Array<{ id: string; customerId: string | null }>,
): Promise<PolicyInputs> {
  const customerIds = [
    ...new Set(items.map((i) => i.customerId).filter((v): v is string => Boolean(v))),
  ];
  const since = new Date(Date.now() - CONTACT_WINDOW_DAYS * 86400_000);
  const haveCustomers = customerIds.length > 0;

  const [optedOutRows, contactRows, downtimeRows, parentRows, attemptRows, customerRows, escalationRows] =
    await Promise.all([
      haveCustomers
        ? db()
            .select({ id: schema.customers.id })
            .from(schema.customers)
            .where(
              and(
                inArray(schema.customers.id, customerIds),
                isNotNull(schema.customers.optedOutAt),
              ),
            )
        : [],
      haveCustomers
        ? db()
            .select({
              customerId: schema.contacts.customerId,
              n: sql<number>`count(*)::int`,
            })
            .from(schema.contacts)
            .where(
              and(
                inArray(schema.contacts.customerId, customerIds),
                gte(schema.contacts.sentAt, since),
              ),
            )
            .groupBy(schema.contacts.customerId)
        : [],
      db()
        .select({
          method: schema.downtimes.method,
          begunAt: sql<Date | null>`max(${schema.downtimes.begin})`,
        })
        .from(schema.downtimes)
        .where(isNull(schema.downtimes.end))
        .groupBy(schema.downtimes.method),
      db()
        .select({ id: schema.riskItems.id, parent: schema.riskItems.parentRiskItemId })
        .from(schema.riskItems),
      db()
        .select({
          riskItemId: schema.decisions.riskItemId,
          n: sql<number>`count(*)::int`,
        })
        .from(schema.actionAttempts)
        .innerJoin(schema.decisions, eq(schema.decisions.id, schema.actionAttempts.decisionId))
        .where(eq(schema.actionAttempts.status, "succeeded"))
        .groupBy(schema.decisions.riskItemId),
      haveCustomers
        ? db()
            .select({
              id: schema.customers.id,
              name: schema.customers.name,
              email: schema.customers.email,
              contact: schema.customers.contact,
            })
            .from(schema.customers)
            .where(inArray(schema.customers.id, customerIds))
        : [],
      db()
        .select({ riskItemId: schema.escalations.riskItemId })
        .from(schema.escalations)
        .where(isNull(schema.escalations.resolvedAt)),
    ]);

  return {
    optedOut: new Set(optedOutRows.map((r) => r.id)),
    contactsByCustomer: new Map(contactRows.map((r) => [r.customerId, r.n])),
    downtimeMethods: new Map(
      downtimeRows
        // A downtime with no `begin` cannot be aged, so it is treated as
        // current rather than silently ignored.
        .map((d) => [d.method, d.begunAt ? new Date(d.begunAt) : new Date()] as const),
    ),
    parentOf: new Map(parentRows.map((r) => [r.id, r.parent])),
    succeededByItem: new Map(attemptRows.map((r) => [r.riskItemId, r.n])),
    customers: new Map(customerRows.map((c) => [c.id, c])),
    openEscalations: new Set(escalationRows.map((e) => e.riskItemId)),
  };
}

/**
 * Successful actions across the whole pursuit, not just this row.
 *
 * A failure on one of our own recovery links opens a NEW risk item, so counting
 * actions on the item alone reset the cap to zero every time — the "max 2
 * actions on this risk item" rule never bound, and only the per-customer
 * fatigue cap stood between us and an unbounded link -> fail -> link cycle.
 * Walking the parent chain makes the rule mean what it says.
 */
function actionsOnChain(riskItemId: string, pre: PolicyInputs): number {
  let total = 0;
  let current: string | null = riskItemId;
  const seen = new Set<string>();

  for (let i = 0; i <= MAX_CHAIN_HOPS && current && !seen.has(current); i++) {
    seen.add(current);
    total += pre.succeededByItem.get(current) ?? 0;
    current = pre.parentOf.get(current) ?? null;
  }
  return total;
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
