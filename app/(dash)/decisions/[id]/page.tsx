import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CircleCheck, ExternalLink, Shield } from "lucide-react";
import {
  ActionLabel,
  ModeBadge,
  StateDot,
  TaxonomyLabel,
  VerdictBadge,
} from "@/components/delta/badges";
import { Money } from "@/components/delta/money";
import { getDecision } from "@/lib/dash/queries";
import { ACTION_COSTS, PATIENCE_COST_PAISE, rankActions, type Action } from "@/lib/ev";
import {
  ACTION_LABEL,
  count,
  humanise,
  istTime,
  RISK_CLASS_LABEL,
  rupees,
  shortId,
} from "@/lib/format";

export default async function DecisionPage({ params }: PageProps<"/decisions/[id]">) {
  const { id } = await params;
  const d = await getDecision(id);
  if (!d) notFound();

  const { decision, riskItem, score, diagnosis, attempts, outcome, escalation, customer, payment } =
    d;

  // Recomputed here from the stored uplift so the page shows the *ranking*, not
  // just the winner. If this disagrees with the stored decision, that is a bug
  // worth seeing rather than hiding.
  const ranking =
    score !== null
      ? rankActions(
          candidatesFor(riskItem.class),
          score.uplift,
          riskItem.amountAtRiskPaise,
        )
      : [];

  const contributions = Object.entries(score?.contributions ?? {}).sort(
    (a, b) => Math.abs(b[1]) - Math.abs(a[1]),
  );
  const maxContrib = Math.max(...contributions.map(([, v]) => Math.abs(v)), 1);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link
          href="/queue"
          className="interactive inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" strokeWidth={2} />
          Queue
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2.5">
          <h1 className="text-xl font-semibold tracking-tight">
            {ACTION_LABEL[decision.proposedAction] ?? decision.proposedAction}
          </h1>
          <VerdictBadge verdict={decision.verdict} />
          {attempts[0] && <ModeBadge mode={attempts[0].mode} />}
        </div>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          decision {decision.id} · {istTime(decision.decidedAt)} IST · policy v
          {decision.policyVersion}
        </p>
      </div>

      {/* ── Why this action, in the order the engine reasoned ─────────── */}
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="animate-rise panel p-5 lg:col-span-2">
          <h2 className="text-sm font-semibold">The arithmetic</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Uplift is the incremental effect <em>of contacting</em> — not the probability of
            payment. An action that never reaches the customer realises none of it.
          </p>

          {score ? (
            <>
              <div className="tabular mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md bg-muted/60 p-3 font-mono text-sm">
                <span className="text-[var(--chart-1)]">{score.uplift.toFixed(4)}</span>
                <span className="text-muted-foreground">×</span>
                <Money paise={riskItem.amountAtRiskPaise} size="inherit" />
                <span className="text-muted-foreground">−</span>
                <Money
                  paise={decision.actionCostPaise}
                  size="inherit"
                  className="text-[var(--notice)]"
                />
                <span className="text-muted-foreground">=</span>
                <Money
                  paise={decision.expectedValuePaise}
                  size="inherit"
                  className={
                    decision.expectedValuePaise > 0
                      ? "font-semibold text-[var(--positive)]"
                      : "font-semibold text-muted-foreground"
                  }
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Cost is {rupees(ACTION_COSTS[decision.proposedAction as Action]?.directPaise ?? 0)}{" "}
                direct
                {ACTION_COSTS[decision.proposedAction as Action]?.consumesPatience
                  ? ` plus ${rupees(PATIENCE_COST_PAISE)} of priced customer patience`
                  : ""}
                . Model {score.modelVersion}.
              </p>
            </>
          ) : (
            <p className="mt-3 rounded-md bg-muted/60 p-3 text-sm text-muted-foreground">
              No score. The policy engine escalates rather than assuming a probability.
            </p>
          )}

          {/* The ranking — do-nothing is always in the running, at exactly 0. */}
          {ranking.length > 0 && (
            <div className="mt-4">
              <h3 className="text-xs font-medium text-muted-foreground">
                Every candidate action, ranked
              </h3>
              <ul className="mt-2 flex flex-col gap-1">
                {ranking.map((r) => {
                  const chosen = r.action === decision.proposedAction;
                  return (
                    <li
                      key={r.action}
                      className={`flex items-center gap-3 rounded-md px-2.5 py-1.5 text-sm ${
                        chosen ? "bg-accent" : ""
                      }`}
                    >
                      <span className={chosen ? "font-medium" : "text-muted-foreground"}>
                        {ACTION_LABEL[r.action] ?? r.action}
                      </span>
                      {chosen && (
                        <span className="text-[10px] font-semibold tracking-wide text-[var(--accent-foreground)] uppercase">
                          chosen
                        </span>
                      )}
                      <Money
                        paise={r.ev.netPaise}
                        size="sm"
                        className={`ml-auto ${
                          r.ev.netPaise > 0 ? "text-[var(--positive)]" : "text-muted-foreground"
                        }`}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>

        {/* ── Policy verdict ─────────────────────────────────────────── */}
        <section
          className="animate-rise panel p-5"
          style={{ animationDelay: "60ms" }}
        >
          <div className="flex items-center gap-2">
            <Shield className="size-4 text-muted-foreground" strokeWidth={2} />
            <h2 className="text-sm font-semibold">Policy</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Evaluated after scoring, before execution. Reasons in the order the rules fired.
          </p>
          <ol className="mt-3 flex flex-col gap-2">
            {decision.verdictReasons.map((r, i) => (
              <li key={i} className="flex gap-2 text-sm">
                <span className="tabular mt-0.5 font-mono text-[10px] text-muted-foreground">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className={i === 0 ? "font-medium" : "text-muted-foreground"}>{r}</span>
              </li>
            ))}
          </ol>
          {decision.deferredUntil && (
            <p className="mt-3 border-t pt-2.5 text-xs text-muted-foreground">
              Deferred until {istTime(decision.deferredUntil)} IST
            </p>
          )}
          {escalation && (
            <p className="mt-3 border-t pt-2.5 text-xs text-[var(--info)]">
              Escalated: {escalation.reason}
            </p>
          )}
        </section>
      </div>

      {/* ── What was scored ───────────────────────────────────────────── */}
      {contributions.length > 0 && (
        <section
          className="animate-rise panel p-5"
          style={{ animationDelay: "120ms" }}
        >
          <h2 className="text-sm font-semibold">What moved the score</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Per-feature contributions from {score?.modelVersion}. Logistic regression was kept over
            gradient boosting precisely so this column exists.
          </p>
          <ul className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {contributions.map(([k, v]) => (
              <li key={k} className="flex items-center gap-2 text-xs">
                <span className="w-40 shrink-0 truncate text-muted-foreground">{k}</span>
                <span className="flex h-1.5 flex-1 items-center">
                  <span className="relative flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <span
                      className="absolute top-0 h-full rounded-full"
                      style={{
                        width: `${(Math.abs(v) / maxContrib) * 50}%`,
                        left: v >= 0 ? "50%" : undefined,
                        right: v < 0 ? "50%" : undefined,
                        background: v >= 0 ? "var(--positive)" : "var(--negative)",
                      }}
                    />
                  </span>
                </span>
                <span className="tabular w-16 text-right font-mono">{v.toFixed(4)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Execution ─────────────────────────────────────────────────── */}
      <section
        className="animate-rise panel p-5"
        style={{ animationDelay: "180ms" }}
      >
        <h2 className="text-sm font-semibold">Execution</h2>
        {attempts.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Nothing was executed. The verdict was {decision.verdict}, and a blocked action makes no
            outbound call.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {attempts.map((a) => (
              <li key={a.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <ActionLabel action={a.action} />
                  <ModeBadge mode={a.mode} />
                  <span className="text-xs text-muted-foreground">
                    attempt {a.attemptNo} · {humanise(a.status)}
                  </span>
                  {a.shortUrl && (
                    <a
                      href={a.shortUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="interactive ml-auto flex items-center gap-1 text-xs text-[var(--primary)] hover:underline"
                    >
                      {a.shortUrl}
                      <ExternalLink className="size-3" strokeWidth={2} />
                    </a>
                  )}
                </div>
                <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                  <Field label="Idempotency key" value={a.idempotencyKey} mono />
                  <Field label="Razorpay entity" value={a.razorpayEntityId ?? "—"} mono />
                  <Field label="Reference id" value={a.referenceId ?? "—"} mono />
                  <Field label="Started" value={`${istTime(a.startedAt)} IST`} />
                </dl>
                {a.error && (
                  <p className="mt-2 rounded bg-[var(--negative-bg)] p-2 font-mono text-[11px] text-[var(--negative)]">
                    {a.error}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 border-t pt-2.5 text-xs text-muted-foreground">
          The idempotency row is written <em>before</em> the outbound call, and the key is UNIQUE in
          the database. A crash mid-flight cannot produce a second payment link.
        </p>
      </section>

      {/* ── Outcome ───────────────────────────────────────────────────── */}
      {outcome && (
        <section
          className="animate-rise rounded-lg border border-[var(--positive)]/30 bg-[var(--positive-bg)] p-4"
          style={{ animationDelay: "240ms" }}
        >
          <div className="flex items-start gap-3">
            <CircleCheck className="mt-0.5 size-5 shrink-0 text-[var(--positive)]" strokeWidth={2} />
            <div>
              <h2 className="text-sm font-semibold text-[var(--positive)]">
                <Money paise={outcome.recoveredAmountPaise} size="inherit" /> recovered
              </h2>
              <p className="mt-1 text-xs text-[var(--positive)]/90">
                Attributed via <strong>{outcome.attributionSource}</strong>
                {outcome.recoveredAt ? ` at ${istTime(outcome.recoveredAt)} IST` : ""}. The
                attribution key travelled on the payment link as{" "}
                <code className="font-mono">notes.decision_id</code>, so this figure is a
                measurement rather than an inference.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* ── The item itself ───────────────────────────────────────────── */}
      <section
        className="animate-rise panel p-5"
        style={{ animationDelay: "300ms" }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Risk item</h2>
          <StateDot state={riskItem.state} />
          {diagnosis && <TaxonomyLabel cls={diagnosis.taxonomyClass} />}
        </div>
        <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Class" value={RISK_CLASS_LABEL[riskItem.class] ?? riskItem.class} />
          <Field label="Amount at risk" value={rupees(riskItem.amountAtRiskPaise)} />
          <Field label="Source" value={riskItem.sourceEntityId} mono />
          <Field label="Detected via" value={humanise(riskItem.detectedVia)} />
          <Field label="Detected" value={`${istTime(riskItem.detectedAt)} IST`} />
          <Field label="Customer" value={customer?.email ?? "—"} />
          {payment?.errorReason && <Field label="Error reason" value={payment.errorReason} mono />}
          {riskItem.closedReason && (
            <Field label="Closed as" value={humanise(riskItem.closedReason)} />
          )}
        </dl>
        {diagnosis?.llmNarrative && (
          <div className="mt-3 border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground">
              Diagnosis narrative
              <span className="ml-1.5 font-normal">
                — {diagnosis.llmModel}, prose only; it moves no money
              </span>
            </p>
            <p className="mt-1 text-sm">{diagnosis.llmNarrative}</p>
          </div>
        )}
      </section>

      {d.siblings.length > 1 && (
        <section className="text-xs text-muted-foreground">
          <p className="mb-1.5 font-medium">
            {count(d.siblings.length)} decisions on this item
          </p>
          <div className="flex flex-wrap gap-1.5">
            {d.siblings.map((s) => (
              <Link
                key={s.id}
                href={`/decisions/${s.id}`}
                className={`interactive rounded-md border px-2 py-1 font-mono ${
                  s.id === decision.id
                    ? "border-[var(--primary)] bg-accent"
                    : "hover:bg-muted"
                }`}
              >
                {shortId(s.id)} · {s.verdict}
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 truncate ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

/** Mirrors lib/ev.ts candidateActions without importing the union type awkwardly. */
function candidatesFor(riskClass: string): Action[] {
  if (riskClass === "overdue_receivable") return ["CHASE_INVOICE", "ESCALATE_HUMAN", "STOP"];
  return ["NUDGE_SMS", "NUDGE_EMAIL", "ESCALATE_HUMAN", "STOP"];
}
