import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { HeroMetric, RailMetric } from "@/components/delta/metrics";
import { Money } from "@/components/delta/money";
import { ActionLabel, ModeBadge, VerdictBadge } from "@/components/delta/badges";
import { SelfRecoveryChart } from "@/components/delta/self-recovery-chart";
import { getOverview, getRecentDecisions } from "@/lib/dash/queries";
import { getEvaluation } from "@/lib/dash/evaluation";
import { ago, count, percent, RISK_CLASS_LABEL, shortId } from "@/lib/format";

export default async function OverviewPage() {
  const [o, feed, evaluation] = await Promise.all([
    getOverview(),
    getRecentDecisions(6),
    getEvaluation(),
  ]);

  const resolved = o.selfRecovered.items + o.afterAction.items;
  const verdictTotal = o.verdicts.reduce((n, v) => n + v.n, 0);

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-[-0.012em]">Overview</h1>
          <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">
            Money at risk on this account, and what was actually recovered.
          </p>
        </div>
        {o.lastBatchAt && (
          <p className="text-[0.75rem] text-muted-foreground">
            Last batch {ago(o.lastBatchAt)}
          </p>
        )}
      </header>

      {/*
        One figure dominates. Recovered revenue is the product; the rest are
        context for it, so they sit on a rail at a third of the visual mass
        instead of four identical tiles pretending everything matters equally.
      */}
      <section className="animate-rise panel-raised grid gap-y-7 p-6 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.15fr)] lg:gap-x-8 lg:p-7">
        <HeroMetric
          label="Recovered after intervention"
          paise={o.recovered.paise}
          provenance="outcomes · result = recovered"
          note={
            o.recovered.items > 0
              ? `${count(o.recovered.items)} recovery attributed to a decision by a signature-verified webhook.`
              : "Nothing attributed yet. A recovery is only counted when a webhook proves it."
          }
        />

        <div className="hidden w-px bg-border lg:block" />

        <div className="grid gap-6 sm:grid-cols-3 lg:gap-5">
          <RailMetric
            label="At risk"
            value={o.atRisk.paise}
            format="rupees"
            tone="notice"
            provenance="risk_items · state in (open, in_progress)"
            note={`${count(o.atRisk.items)} open or in progress`}
          />
          <RailMetric
            label="Self-recovered"
            value={o.selfRecovered.items}
            format="count"
            tone="muted"
            provenance="risk_items · closed_reason = self_recovered_without_intervention"
            note="paid with no contact — we take no credit"
          />
          <RailMetric
            label="Spent"
            value={o.spend.paise}
            format="rupees"
            provenance="action_attempts · status = succeeded"
            note={`${count(o.spend.contacts)} contact${o.spend.contacts === 1 ? "" : "s"}`}
          />
        </div>
      </section>

      {/* ── Credit not claimed ───────────────────────────────────────── */}
      {resolved > 0 && (
        <section
          className="animate-rise panel p-5 sm:p-6"
          style={{ animationDelay: "80ms" }}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="text-[0.9375rem] font-semibold">Credit not claimed</h2>
            <p className="text-[0.75rem] text-muted-foreground">
              {count(resolved)} resolved item{resolved === 1 ? "" : "s"}
            </p>
          </div>
          <p className="mt-1.5 max-w-[68ch] text-[0.8125rem] leading-relaxed text-muted-foreground">
            <strong className="font-medium text-foreground">
              {count(o.selfRecovered.items)}
            </strong>{" "}
            of them paid without any contact from us. Delta records those as self-recovery and
            claims none of it — attributing that money would inflate the recovered figure with
            revenue that was already arriving.
          </p>

          <div className="mt-4 flex h-1.5 gap-0.5 overflow-hidden rounded-full">
            <div
              className="rounded-l-full bg-[var(--positive)]"
              style={{ width: `${(o.afterAction.items / resolved) * 100}%` }}
            />
            <div
              className="rounded-r-full bg-border"
              style={{ width: `${(o.selfRecovered.items / resolved) * 100}%` }}
            />
          </div>
          <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-[0.75rem] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-[var(--positive)]" />
              {count(o.afterAction.items)} after intervention
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-border" />
              {count(o.selfRecovered.items)} self-recovered
            </span>
          </div>
        </section>
      )}

      <div className="grid gap-5 lg:grid-cols-5">
        {/* ── The thesis ─────────────────────────────────────────────── */}
        <section
          className="animate-rise panel p-5 sm:p-6 lg:col-span-3"
          style={{ animationDelay: "120ms" }}
        >
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[0.9375rem] font-semibold">
              Most of this money recovers on its own
            </h2>
            <Link
              href="/evaluation"
              className="interactive flex shrink-0 items-center gap-0.5 text-[0.75rem] text-[var(--primary)] hover:underline"
            >
              Evaluation
              <ArrowUpRight className="size-3" strokeWidth={2} />
            </Link>
          </div>
          <p className="mt-1 max-w-[62ch] text-[0.8125rem] leading-relaxed text-muted-foreground">
            The share of each class that pays with no contact at all, against the lift a contact
            actually buys. Where the blue tip is short, contacting earns almost nothing.
          </p>
          <SelfRecoveryChart byClass={evaluation.by_class} />
          <p
            className="mt-4 rule-t pt-3 font-mono text-[0.6875rem] text-muted-foreground"
            title="eval/results.json"
          >
            Held-out test split · n={count(evaluation.test_items)} · seed {evaluation.seed}
          </p>
        </section>

        {/* ── Decision feed ──────────────────────────────────────────── */}
        <section
          className="animate-rise panel flex flex-col lg:col-span-2"
          style={{ animationDelay: "160ms" }}
        >
          <div className="flex items-baseline justify-between gap-2 border-b px-5 py-3.5">
            <h2 className="text-[0.9375rem] font-semibold">Latest decisions</h2>
            <Link
              href="/queue"
              className="interactive text-[0.75rem] text-[var(--primary)] hover:underline"
            >
              Queue
            </Link>
          </div>

          {feed.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 px-5 py-12 text-center">
              <p className="text-[0.8125rem] font-medium">No decisions yet</p>
              <p className="max-w-[30ch] text-[0.75rem] text-muted-foreground">
                Run a batch and every decision — including the blocked ones — will appear here.
              </p>
            </div>
          ) : (
            <ul className="divide-y">
              {feed.map((f) => (
                <li key={f.id}>
                  <Link
                    href={`/decisions/${f.id}`}
                    className="interactive block px-5 py-3 hover:bg-muted/50"
                  >
                    <div className="flex items-center gap-2">
                      <VerdictBadge verdict={f.verdict} />
                      <ActionLabel action={f.action} />
                      <ModeBadge mode={f.mode} />
                      <Money paise={f.amountPaise} size="sm" compact className="ml-auto" muted />
                    </div>
                    {f.reason && (
                      <p className="mt-1.5 line-clamp-1 text-[0.75rem] text-muted-foreground">
                        {f.reason}
                      </p>
                    )}
                    <p className="mt-1 font-mono text-[0.6875rem] text-muted-foreground/70">
                      {shortId(f.id)} · {ago(f.decidedAt)}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* ── By class, and policy outcomes ────────────────────────────── */}
      <div className="grid gap-5 lg:grid-cols-2">
        <section
          className="animate-rise panel p-5 sm:p-6"
          style={{ animationDelay: "200ms" }}
        >
          <h2 className="text-[0.9375rem] font-semibold">By risk class</h2>
          {o.openByClass.length === 0 ? (
            <p className="mt-4 text-[0.8125rem] text-muted-foreground">
              No risk items detected yet.
            </p>
          ) : (
            <table className="mt-4 w-full text-[0.8125rem]">
              <thead>
                <tr className="border-b">
                  <th className="pb-2 text-left text-[0.6875rem] font-medium tracking-[0.07em] text-muted-foreground uppercase">
                    Class
                  </th>
                  <th className="pb-2 text-right text-[0.6875rem] font-medium tracking-[0.07em] text-muted-foreground uppercase">
                    Open
                  </th>
                  <th className="pb-2 text-right text-[0.6875rem] font-medium tracking-[0.07em] text-muted-foreground uppercase">
                    At risk
                  </th>
                  <th className="pb-2 text-right text-[0.6875rem] font-medium tracking-[0.07em] text-muted-foreground uppercase">
                    Recovered
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {o.openByClass.map((c) => (
                  <tr key={c.class}>
                    <td className="py-2.5">{RISK_CLASS_LABEL[c.class] ?? c.class}</td>
                    <td className="tabular py-2.5 text-right">{count(c.openCount)}</td>
                    <td className="py-2.5 text-right">
                      <Money paise={c.openPaise} size="sm" muted />
                    </td>
                    <td className="py-2.5 text-right">
                      {c.recoveredCount > 0 ? (
                        <Money
                          paise={c.recoveredPaise}
                          size="sm"
                          className="text-[var(--positive)]"
                        />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section
          className="animate-rise panel p-5 sm:p-6"
          style={{ animationDelay: "240ms" }}
        >
          <h2 className="text-[0.9375rem] font-semibold">What the policy engine did</h2>
          <p className="mt-1 max-w-[58ch] text-[0.8125rem] leading-relaxed text-muted-foreground">
            A blocked action produces a decision row exactly like a sent one, so a STOP is as
            auditable as a send.
          </p>
          {o.verdicts.length === 0 ? (
            <p className="mt-4 text-[0.8125rem] text-muted-foreground">
              No decisions recorded yet.
            </p>
          ) : (
            <ul className="mt-4 flex flex-col gap-2.5">
              {o.verdicts.map((v) => (
                <li key={v.verdict} className="flex items-center gap-3">
                  <VerdictBadge verdict={v.verdict} className="w-[4.5rem] justify-center" />
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-[var(--primary)]"
                      style={{ width: `${(v.n / verdictTotal) * 100}%` }}
                    />
                  </div>
                  <span className="tabular w-16 text-right text-[0.75rem] text-muted-foreground">
                    {count(v.n)} · {percent(v.n / verdictTotal, 0)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {o.escalationsOpen > 0 && (
            <p className="rule-t mt-4 pt-3 text-[0.75rem] text-muted-foreground">
              {count(o.escalationsOpen)} open escalation
              {o.escalationsOpen === 1 ? "" : "s"} awaiting a human.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
