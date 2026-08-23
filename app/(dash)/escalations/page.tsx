import Link from "next/link";
import { ArrowUpRight, UserCheck } from "lucide-react";
import { Money } from "@/components/delta/money";
import { ActionLabel, StateDot, SyntheticBadge } from "@/components/delta/badges";
import { ResolveForm } from "@/components/delta/resolve-form";
import { escalationStats, getEscalations } from "@/lib/dash/queries";
import { ago, count, percent, RISK_CLASS_LABEL, shortId } from "@/lib/format";

export const metadata = { title: "Escalations — Delta" };

export default async function EscalationsPage({ searchParams }: PageProps<"/escalations">) {
  const params = await searchParams;
  const showResolved = params.show === "resolved";

  const [rows, stats] = await Promise.all([
    getEscalations(showResolved),
    escalationStats(),
  ]);
  const list = showResolved ? rows.filter((r) => r.resolvedAt) : rows;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-[-0.012em]">Escalations</h1>
          <p className="mt-0.5 max-w-2xl text-[0.8125rem] text-muted-foreground">
            Cases the policy engine refused to automate. Each one names the rule that stopped it,
            so a reviewer can see why it arrived rather than guessing.
          </p>
        </div>
        <div className="flex gap-1 text-[0.75rem]">
          <Tab href="/escalations" label={`Open ${stats.open}`} active={!showResolved} />
          <Tab
            href="/escalations?show=resolved"
            label={`Resolved ${stats.resolved}`}
            active={showResolved}
          />
        </div>
      </header>

      {/* Escalation precision — the reason the resolve step asks two questions. */}
      <section className="animate-rise panel grid gap-6 p-5 sm:grid-cols-3 sm:p-6">
        <div>
          <p className="text-[0.6875rem] font-medium tracking-[0.09em] text-muted-foreground uppercase">
            Awaiting a human
          </p>
          <p className="tabular mt-2 text-2xl leading-none font-semibold">{count(stats.open)}</p>
          <p className="mt-1.5 text-[0.75rem] text-muted-foreground">
            <Money paise={stats.openPaise} size="sm" muted /> at risk
          </p>
        </div>
        <div>
          <p className="text-[0.6875rem] font-medium tracking-[0.09em] text-muted-foreground uppercase">
            Reviewed
          </p>
          <p className="tabular mt-2 text-2xl leading-none font-semibold">{count(stats.judged)}</p>
          <p className="mt-1.5 text-[0.75rem] text-muted-foreground">
            judged necessary or not
          </p>
        </div>
        <div>
          <p className="text-[0.6875rem] font-medium tracking-[0.09em] text-muted-foreground uppercase">
            Escalation precision
          </p>
          <p className="tabular mt-2 text-2xl leading-none font-semibold">
            {stats.judged > 0 ? percent(stats.necessary / stats.judged, 0) : "—"}
          </p>
          <p className="mt-1.5 text-[0.75rem] text-muted-foreground">
            {stats.judged > 0
              ? `${count(stats.necessary)} of ${count(stats.judged)} genuinely needed a person`
              : "resolve a few to measure this"}
          </p>
        </div>
      </section>

      {list.length === 0 ? (
        <section className="panel flex flex-col items-center gap-1.5 px-5 py-16 text-center">
          <UserCheck className="size-5 text-muted-foreground" strokeWidth={2} />
          <p className="text-[0.875rem] font-medium">
            {showResolved ? "Nothing resolved yet" : "Nothing awaiting a human"}
          </p>
          <p className="max-w-[46ch] text-[0.8125rem] text-muted-foreground">
            {showResolved
              ? "Resolved escalations will appear here with the judgement recorded against them."
              : "When a case is above the high-value threshold, flagged for risk, or cannot be scored, it lands here instead of being automated."}
          </p>
        </section>
      ) : (
        <ul className="flex flex-col gap-3">
          {list.map((e, i) => (
            <li
              key={e.id}
              className="animate-rise panel p-5"
              style={{ animationDelay: `${Math.min(i * 30, 300)}ms` }}
            >
              <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="text-[0.9375rem] font-semibold">
                      {RISK_CLASS_LABEL[e.class] ?? e.class}
                    </span>
                    <StateDot state={e.state} />
                    {e.synthetic && <SyntheticBadge />}
                  </div>

                  {/* The rule that stopped it. This is the whole point of the row. */}
                  <p className="mt-2 max-w-[70ch] text-[0.8125rem] leading-relaxed">{e.reason}</p>

                  <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[0.75rem] text-muted-foreground">
                    <span>
                      <dt className="inline">Customer </dt>
                      <dd className="inline text-foreground">
                        {e.customerEmail ?? e.customerContact ?? "unknown"}
                      </dd>
                    </span>
                    {e.errorReason && (
                      <span>
                        <dt className="inline">Reason </dt>
                        <dd className="inline font-mono">{e.errorReason}</dd>
                      </span>
                    )}
                    <span>
                      <dt className="inline">Source </dt>
                      <dd className="inline font-mono">{e.sourceEntityId}</dd>
                    </span>
                    <span>
                      <dt className="inline">Raised </dt>
                      <dd className="inline">{ago(e.assignedAt)}</dd>
                    </span>
                  </dl>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <Money paise={e.amountPaise} size="lg" />
                  {e.proposedAction && (
                    <span className="text-[0.75rem] text-muted-foreground">
                      agent proposed <ActionLabel action={e.proposedAction} />
                    </span>
                  )}
                  {e.decisionId && (
                    <Link
                      href={`/decisions/${e.decisionId}`}
                      className="interactive flex items-center gap-0.5 text-[0.75rem] text-[var(--primary)] hover:underline"
                    >
                      Trace {shortId(e.decisionId)}
                      <ArrowUpRight className="size-3" strokeWidth={2} />
                    </Link>
                  )}
                </div>
              </div>

              {e.resolvedAt ? (
                <div className="rule-t mt-4 pt-3">
                  <p className="text-[0.75rem] text-muted-foreground">
                    Resolved {ago(e.resolvedAt)} ·{" "}
                    {e.wasNecessary === null
                      ? "no judgement recorded"
                      : e.wasNecessary
                        ? "needed a human"
                        : "did not need a human"}
                  </p>
                  <p className="mt-1 text-[0.8125rem]">{e.resolution}</p>
                </div>
              ) : (
                <ResolveForm id={e.id} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Tab({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`interactive rounded-md border px-2.5 py-1 font-medium ${
        active
          ? "border-[var(--primary)]/40 bg-accent text-[var(--accent-foreground)]"
          : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {label}
    </Link>
  );
}
