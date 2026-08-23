import Link from "next/link";
import { ArrowUpRight, ShieldCheck } from "lucide-react";
import { StatTile } from "@/components/delta/stat-tile";
import { ActionBadge, ModeBadge, VerdictBadge } from "@/components/delta/badges";
import { SelfRecoveryChart } from "@/components/delta/self-recovery-chart";
import { getOverview, getRecentDecisions } from "@/lib/dash/queries";
import { getEvaluation } from "@/lib/dash/evaluation";
import { ago, count, percent, RISK_CLASS_LABEL, rupees, shortId } from "@/lib/format";

export default async function OverviewPage() {
  const [o, feed, evaluation] = await Promise.all([
    getOverview(),
    getRecentDecisions(7),
    getEvaluation(),
  ]);

  const resolved = o.selfRecovered.items + o.afterAction.items;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Money at risk on this Razorpay account, and what was actually recovered.
          </p>
        </div>
        {o.lastBatchAt && (
          <p className="text-xs text-muted-foreground">
            Last decision batch {ago(o.lastBatchAt)}
          </p>
        )}
      </header>

      {/* ── The four numbers that matter ─────────────────────────────── */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="At risk now"
          value={o.atRisk.paise}
          format="rupees"
          sublabel={`${count(o.atRisk.items)} open or in progress`}
          provenance="risk_items · open + in_progress"
          tone="notice"
          delayMs={0}
        />
        <StatTile
          label="Recovered after intervention"
          value={o.recovered.paise}
          format="rupees"
          sublabel={
            o.recovered.items > 0
              ? `${count(o.recovered.items)} attributed via webhook`
              : "nothing attributed yet"
          }
          provenance="outcomes · result = recovered"
          tone="positive"
          delayMs={60}
        />
        <StatTile
          label="Self-recovered"
          value={o.selfRecovered.items}
          format="count"
          sublabel="paid without us contacting anyone"
          provenance="risk_items · self_recovered_without_intervention"
          tone="muted"
          delayMs={120}
        />
        <StatTile
          label="Spent to recover"
          value={o.spend.paise}
          format="rupees"
          sublabel={`${count(o.spend.contacts)} contact${o.spend.contacts === 1 ? "" : "s"} · ${rupees(o.spend.patiencePaise)} patience priced`}
          provenance="action_attempts · succeeded"
          delayMs={180}
        />
      </section>

      {/* ── Credit not claimed ───────────────────────────────────────── */}
      {resolved > 0 && (
        <section
          className="animate-rise rounded-lg border bg-card p-4 elevation-low"
          style={{ animationDelay: "240ms" }}
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--positive-bg)] text-[var(--positive)]">
              <ShieldCheck className="size-4" strokeWidth={2} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold">Credit not claimed</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Of {count(resolved)} resolved item{resolved === 1 ? "" : "s"},{" "}
                <strong className="font-semibold text-foreground">
                  {count(o.selfRecovered.items)}
                </strong>{" "}
                paid without any contact from us. Delta records those as self-recovery and takes
                no credit — attributing them would inflate the recovered figure with money that
                was arriving anyway.
              </p>

              {/* A proportion bar, not a chart: two categories and a small n. */}
              <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="bg-[var(--positive)]"
                  style={{ width: `${(o.afterAction.items / resolved) * 100}%` }}
                />
                <div
                  className="bg-border"
                  style={{ width: `${(o.selfRecovered.items / resolved) * 100}%` }}
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-sm bg-[var(--positive)]" />
                  {count(o.afterAction.items)} after intervention
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-sm bg-border" />
                  {count(o.selfRecovered.items)} self-recovered
                </span>
              </div>
            </div>
          </div>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-5">
        {/* ── The thesis, on held-out data ───────────────────────────── */}
        <section
          className="animate-rise rounded-lg border bg-card p-4 elevation-low lg:col-span-3"
          style={{ animationDelay: "300ms" }}
        >
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold">Most of this money recovers on its own</h2>
            <Link
              href="/evaluation"
              className="interactive flex shrink-0 items-center gap-0.5 text-xs text-[var(--primary)] hover:underline"
            >
              Evaluation
              <ArrowUpRight className="size-3" strokeWidth={2} />
            </Link>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Share of each class that pays with no contact at all, against the incremental lift a
            contact actually buys. Where the bars are close, contacting earns almost nothing.
          </p>
          <SelfRecoveryChart byClass={evaluation.by_class} />
          <p className="mt-3 border-t pt-2.5 font-mono text-[10px] text-muted-foreground/70">
            eval/results.json · held-out test split · n={count(evaluation.test_items)} items ·
            seed {evaluation.seed}
          </p>
        </section>

        {/* ── Decision feed ──────────────────────────────────────────── */}
        <section
          className="animate-rise rounded-lg border bg-card lg:col-span-2"
          style={{ animationDelay: "360ms" }}
        >
          <div className="flex items-baseline justify-between gap-2 border-b p-4 pb-3">
            <h2 className="text-sm font-semibold">Latest decisions</h2>
            <Link
              href="/queue"
              className="interactive text-xs text-[var(--primary)] hover:underline"
            >
              Queue
            </Link>
          </div>
          {feed.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No decisions yet. Run a batch to populate this.
            </p>
          ) : (
            <ul className="divide-y">
              {feed.map((f) => (
                <li key={f.id}>
                  <Link
                    href={`/decisions/${f.id}`}
                    className="interactive block px-4 py-2.5 hover:bg-muted/60"
                  >
                    <div className="flex items-center gap-2">
                      <VerdictBadge verdict={f.verdict} />
                      <ActionBadge action={f.action} />
                      <ModeBadge mode={f.mode} />
                      <span className="tabular ml-auto text-xs font-medium">
                        {rupees(f.amountPaise, { compact: true })}
                      </span>
                    </div>
                    {f.reason && (
                      <p className="mt-1.5 line-clamp-1 text-xs text-muted-foreground">
                        {f.reason}
                      </p>
                    )}
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground/60">
                      {shortId(f.id)} · {ago(f.decidedAt)}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* ── By class, and what the policy engine did ─────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section
          className="animate-rise rounded-lg border bg-card p-4 elevation-low"
          style={{ animationDelay: "420ms" }}
        >
          <h2 className="text-sm font-semibold">By risk class</h2>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="pb-2 font-medium">Class</th>
                <th className="pb-2 text-right font-medium">Open</th>
                <th className="pb-2 text-right font-medium">At risk</th>
                <th className="pb-2 text-right font-medium">Recovered</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {o.openByClass.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-3 text-muted-foreground">
                    No risk items yet.
                  </td>
                </tr>
              )}
              {o.openByClass.map((c) => (
                <tr key={c.class}>
                  <td className="py-2">{RISK_CLASS_LABEL[c.class] ?? c.class}</td>
                  <td className="tabular py-2 text-right">{count(c.openCount)}</td>
                  <td className="tabular py-2 text-right">{rupees(c.openPaise)}</td>
                  <td className="tabular py-2 text-right text-[var(--positive)]">
                    {c.recoveredCount > 0 ? rupees(c.recoveredPaise) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section
          className="animate-rise rounded-lg border bg-card p-4 elevation-low"
          style={{ animationDelay: "480ms" }}
        >
          <h2 className="text-sm font-semibold">What the policy engine did</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            A blocked action produces a decision row exactly like a sent one, so a STOP is as
            auditable as a send.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {o.verdicts.length === 0 && (
              <li className="text-sm text-muted-foreground">No decisions recorded yet.</li>
            )}
            {o.verdicts.map((v) => {
              const total = o.verdicts.reduce((n, x) => n + x.n, 0);
              return (
                <li key={v.verdict} className="flex items-center gap-3">
                  <VerdictBadge verdict={v.verdict} className="w-24 justify-center" />
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-[var(--primary)]"
                      style={{ width: `${(v.n / total) * 100}%` }}
                    />
                  </div>
                  <span className="tabular w-14 text-right text-xs text-muted-foreground">
                    {count(v.n)} · {percent(v.n / total, 0)}
                  </span>
                </li>
              );
            })}
          </ul>
          {o.escalationsOpen > 0 && (
            <p className="mt-3 border-t pt-2.5 text-xs text-muted-foreground">
              {count(o.escalationsOpen)} open escalation
              {o.escalationsOpen === 1 ? "" : "s"} awaiting a human.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
