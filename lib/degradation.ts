import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db";
import { ask } from "./llm";
import { DEFAULT_POLICY } from "./policy";

/**
 * Payment degradation -> root cause -> recovery action.
 *
 * The first example direction Track 03 lists, and the place where an LLM does
 * something deterministic code genuinely cannot: synthesise a cause from
 * heterogeneous evidence (error taxonomy, timing concentration, rate against
 * baseline, live outage records) and say what should happen about it.
 *
 * But it is not trusted. The flow is deliberately three-stage:
 *
 *   1. DETERMINISTIC   cluster the failures, compute rate against a 7-day
 *                      baseline, pull live downtime records
 *   2. LLM             form a hypothesis about cause and disposition
 *   3. DETERMINISTIC   corroborate that hypothesis against independent evidence;
 *                      only a corroborated hypothesis is allowed to defer
 *                      anything, and every override is recorded
 *
 * So the model's output is load-bearing — it can stop a whole cluster of
 * contacts from going out — while never being the authority. An uncorroborated
 * claim of an outage changes nothing except an audit row saying we disagreed.
 */

const ClusterVerdict = z.object({
  cluster_id: z.string(),
  cause: z.enum([
    "infrastructure_outage",
    "issuer_decline_pattern",
    "customer_behaviour",
    "unclear",
  ]),
  confidence: z.number().min(0).max(1),
  recommended_disposition: z.enum(["DEFER_UNTIL_RESOLVED", "PROCEED", "ESCALATE"]),
  // No length cap: Gemini ignores maxLength in structured output and the whole
  // response then fails validation. Truncated after parsing instead.
  rationale: z.string(),
});

const Analysis = z.object({ clusters: z.array(ClusterVerdict) });

export interface Cluster {
  id: string;
  method: string | null;
  bank: string | null;
  errorReason: string | null;
  count: number;
  amountPaise: number;
  spanMinutes: number;
  /** Failures per hour now, versus this cluster's own trailing 7-day rate. */
  rateMultiple: number;
  downtimeCorroborated: boolean;
  riskItemIds: string[];
}

export interface ClusterFinding extends Cluster {
  cause: string;
  confidence: number;
  disposition: "DEFER_UNTIL_RESOLVED" | "PROCEED" | "ESCALATE";
  rationale: string;
  /** True when we overrode the model because evidence did not support it. */
  overridden: boolean;
  overrideReason?: string;
  model: string | null;
}

/** Rate multiple above which a spike counts as independent corroboration. */
const SPIKE_THRESHOLD = 3.0;
/** A genuine infrastructure event is concentrated, not spread over a day. */
const MAX_SPAN_MINUTES = 180;

/** Stage 1 — deterministic clustering over currently open failed payments. */
export async function buildClusters(windowHours = 6): Promise<Cluster[]> {
  const since = new Date(Date.now() - windowHours * 3600_000);

  const rows = await db()
    .select({
      riskItemId: schema.riskItems.id,
      amount: schema.riskItems.amountAtRiskPaise,
      detectedAt: schema.riskItems.detectedAt,
      method: schema.payments.method,
      bank: schema.payments.bank,
      errorReason: schema.payments.errorReason,
    })
    .from(schema.riskItems)
    .innerJoin(
      schema.payments,
      eq(schema.payments.razorpayPaymentId, schema.riskItems.sourceEntityId),
    )
    .where(
      and(
        eq(schema.riskItems.state, "open"),
        eq(schema.riskItems.class, "failed_payment"),
        gte(schema.riskItems.detectedAt, since),
      ),
    );

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.method ?? "?"}|${r.bank ?? "?"}|${r.errorReason ?? "?"}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }

  // Same staleness bound the policy engine applies, and for the same reason:
  // Razorpay never closes a downtime record, so an unbounded "is it down?"
  // returns true forever. Here it matters more than anywhere else — this is the
  // independent evidence that decides whether the LLM is allowed to defer a
  // whole cluster, and a permanently-true corroboration check is no check.
  const staleBefore = new Date(
    Date.now() - DEFAULT_POLICY.staleDowntimeHours * 3600_000,
  );
  const openDowntimes = await db()
    .select({ method: schema.downtimes.method })
    .from(schema.downtimes)
    .where(
      and(
        isNull(schema.downtimes.end),
        gte(schema.downtimes.begin, staleBefore),
      ),
    );
  const downMethods = new Set(openDowntimes.map((d) => d.method));

  const clusters: Cluster[] = [];
  for (const [key, items] of groups) {
    if (items.length < 3) continue; // not a pattern, just noise

    const [method, bank, errorReason] = key.split("|");
    const times = items.map((i) => i.detectedAt.getTime()).sort((a, b) => a - b);
    const spanMinutes = Math.max(1, (times[times.length - 1] - times[0]) / 60_000);

    clusters.push({
      id: key,
      method: method === "?" ? null : method,
      bank: bank === "?" ? null : bank,
      errorReason: errorReason === "?" ? null : errorReason,
      count: items.length,
      amountPaise: items.reduce((s, i) => s + i.amount, 0),
      spanMinutes: Math.round(spanMinutes),
      rateMultiple: await rateAgainstBaseline(method, bank, items.length, windowHours),
      downtimeCorroborated: method !== "?" && downMethods.has(method),
      riskItemIds: items.map((i) => i.riskItemId),
    });
  }

  return clusters.sort((a, b) => b.amountPaise - a.amountPaise);
}

/** Current failure rate for this instrument versus its own trailing 7-day rate. */
async function rateAgainstBaseline(
  method: string,
  bank: string,
  count: number,
  windowHours: number,
): Promise<number> {
  if (method === "?") return 1;
  const weekAgo = new Date(Date.now() - 7 * 86400_000);
  // The analysis window must be EXCLUDED from its own baseline, or the current
  // spike inflates the very number it is being compared against and every
  // cluster looks anomalous.
  const windowStart = new Date(Date.now() - windowHours * 3600_000);

  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.status, "failed"),
        eq(schema.payments.method, method),
        bank === "?" ? sql`true` : eq(schema.payments.bank, bank),
        gte(schema.payments.createdAtRzp, weekAgo),
        lt(schema.payments.createdAtRzp, windowStart),
      ),
    );

  const baselineHours = 7 * 24 - windowHours;
  const baselinePerHour = (row?.n ?? 0) / baselineHours;

  // No history for this instrument. A small cluster is not evidence of anything;
  // a large one is treated as borderline rather than assumed to be a spike.
  if (baselinePerHour <= 0) return count >= 5 ? SPIKE_THRESHOLD : 1;
  return Number(((count / windowHours) / baselinePerHour).toFixed(2));
}

/** Stages 2 and 3 — hypothesise, then corroborate before allowing any effect. */
export async function analyseDegradation(windowHours = 6): Promise<{
  findings: ClusterFinding[];
  deferredRiskItemIds: Set<string>;
  llmUsed: boolean;
}> {
  const clusters = await buildClusters(windowHours);
  if (clusters.length === 0) {
    return { findings: [], deferredRiskItemIds: new Set(), llmUsed: false };
  }

  const evidence = clusters
    .map(
      (c) =>
        `- cluster_id "${c.id}": ${c.count} failures worth Rs ${(c.amountPaise / 100).toLocaleString("en-IN")}, ` +
        `method=${c.method ?? "unknown"}, bank=${c.bank ?? "unknown"}, error_reason=${c.errorReason ?? "unknown"}, ` +
        `spread over ${c.spanMinutes} minutes, ${c.rateMultiple}x this instrument's 7-day baseline rate, ` +
        `Razorpay downtime currently reported for this method: ${c.downtimeCorroborated ? "YES" : "no"}`,
    )
    .join("\n");

  const result = await ask(
    Analysis,
    `Clusters of failed Razorpay payments in the last ${windowHours} hours:\n\n${evidence}\n\n` +
      `For each cluster, identify the most likely root cause and what should happen to the ` +
      `recovery attempts queued against it. Recommend DEFER_UNTIL_RESOLVED only when the ` +
      `evidence points to an infrastructure or issuer-side problem that a customer cannot ` +
      `act around — sending someone a payment link during an outage wastes the contact and ` +
      `their patience. Return one entry per cluster_id given, using those exact ids.`,
    {
      system:
        "You are a payments reliability analyst. Reason only from the evidence provided. " +
        "Do not invent cluster ids. Be conservative: an unclear cause is a valid answer.",
      timeoutMs: 25_000,
    },
  );

  const byId = new Map(clusters.map((c) => [c.id, c]));
  const findings: ClusterFinding[] = [];
  const deferred = new Set<string>();

  for (const c of clusters) {
    const v = result?.value.clusters.find((x) => x.cluster_id === c.id);

    // No model output, or a hallucinated cluster id: fall back to evidence alone.
    if (!v) {
      const spike = c.downtimeCorroborated || c.rateMultiple >= SPIKE_THRESHOLD;
      findings.push({
        ...c,
        cause: spike ? "infrastructure_outage" : "unclear",
        confidence: spike ? 0.5 : 0.2,
        disposition: spike && c.downtimeCorroborated ? "DEFER_UNTIL_RESOLVED" : "PROCEED",
        rationale: result
          ? "Model returned no verdict for this cluster; fell back to evidence."
          : "Model unavailable; classified from downtime and rate evidence alone.",
        overridden: false,
        model: result?.model ?? null,
      });
      if (spike && c.downtimeCorroborated) c.riskItemIds.forEach((id) => deferred.add(id));
      continue;
    }

    // ── Stage 3: does independent evidence support the hypothesis? ─────────
    let disposition = v.recommended_disposition;
    let overridden = false;
    let overrideReason: string | undefined;

    if (disposition === "DEFER_UNTIL_RESOLVED") {
      const corroborated =
        c.downtimeCorroborated ||
        (c.rateMultiple >= SPIKE_THRESHOLD && c.spanMinutes <= MAX_SPAN_MINUTES);

      if (!corroborated) {
        disposition = "PROCEED";
        overridden = true;
        overrideReason =
          `Model proposed deferring this cluster, but no Razorpay downtime is reported for ` +
          `${c.method ?? "this method"} and the failure rate (${c.rateMultiple}x baseline over ` +
          `${c.spanMinutes} min) does not meet the spike threshold (${SPIKE_THRESHOLD}x within ` +
          `${MAX_SPAN_MINUTES} min). Proceeding.`;
      }
    }

    if (disposition === "DEFER_UNTIL_RESOLVED") {
      c.riskItemIds.forEach((id) => deferred.add(id));
    }

    findings.push({
      ...c,
      cause: v.cause,
      confidence: v.confidence,
      disposition,
      rationale: v.rationale.slice(0, 600),
      overridden,
      overrideReason,
      model: result?.model ?? null,
    });
  }

  return { findings, deferredRiskItemIds: deferred, llmUsed: Boolean(result) };
}

/** Persists findings so the demo and the audit trail can show the reasoning. */
export async function persistFindings(findings: ClusterFinding[]): Promise<void> {
  // One statement, not one per risk item. A cluster covers every open failure
  // sharing a method/bank/reason, so the row-at-a-time version issued a serial
  // round-trip for each of them on every batch.
  const rows = findings.flatMap((f) =>
    f.riskItemIds.map((riskItemId) => ({
      riskItemId,
      taxonomyClass: "TRANSIENT" as const,
      deterministicReason:
        `Cluster ${f.id}: ${f.count} failures, ${f.rateMultiple}x baseline over ${f.spanMinutes} min, ` +
        `downtime reported: ${f.downtimeCorroborated ? "yes" : "no"}`,
      llmNarrative: f.overridden
        ? `${f.rationale}\n\nOVERRIDDEN BY EVIDENCE: ${f.overrideReason}`
        : f.rationale,
      llmModel: f.model,
      llmCacheKey: f.id,
    })),
  );

  if (rows.length === 0) return;
  await db().insert(schema.diagnoses).values(rows);
}
