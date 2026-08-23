import { BudgetChart } from "@/components/delta/budget-chart";
import { getEvaluation } from "@/lib/dash/evaluation";
import { RANKERS } from "@/lib/dash/rankers";
import { count, percent, rupees } from "@/lib/format";

export const metadata = { title: "Evaluation — Delta" };

export default async function EvaluationPage() {
  const e = await getEvaluation();
  const headline = e.budget_table.find((b) => b.budget === e.headline_budget);
  const oracle = e.unconstrained.oracle_ev;
  const contactAll = e.unconstrained.contact_all;

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Evaluation</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Held-out test split, opened once. Every figure on this page is read from{" "}
          <code className="font-mono text-xs">eval/results.json</code>; none is typed by hand.
        </p>
      </header>

      {/* ── Headline ─────────────────────────────────────────────────── */}
      <section className="grid gap-3 sm:grid-cols-3">
        <Headline
          value={`+${e.headline_lift_vs_amount_pct}%`}
          label="vs ranking by ticket size"
          detail="The obvious heuristic: chase the biggest invoices."
        />
        <Headline
          value={`+${e.headline_lift_vs_recovery_prob_pct}%`}
          label="vs ranking by recovery probability"
          detail="The subtle trap: chase whoever is most likely to pay — most of whom would have paid anyway."
        />
        <Headline
          value={percent(contactAll.wasted_contact_rate, 1)}
          label="of contact-everything is wasted"
          detail={`${count(contactAll.wasted_contacts)} of ${count(contactAll.contacts)} contacts reach someone who was going to pay regardless.`}
          tone="notice"
        />
      </section>

      {/* ── The chart ────────────────────────────────────────────────── */}
      <section className="animate-rise panel p-5">
        <h2 className="text-sm font-semibold">
          The budget is what makes ranking matter
        </h2>
        <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
          Net incremental revenue = revenue(policy) − revenue(do-nothing) − contact spend. Only
          money above the do-nothing floor is claimable. Give every strategy an unlimited budget
          and they converge on contacting everyone; the separation below is what a real constraint
          buys.
        </p>
        <BudgetChart rows={e.budget_table} />
      </section>

      {/* ── Baselines ────────────────────────────────────────────────── */}
      <section className="animate-rise panel p-5">
        <h2 className="text-sm font-semibold">
          At the headline budget of {count(e.headline_budget)} contacts
        </h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="pb-2 font-medium">Strategy</th>
                <th className="pb-2 text-right font-medium">Net incremental</th>
                <th className="pb-2 text-right font-medium">95% CI</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {RANKERS.map((r) => {
                const v = headline?.[r.key] ?? 0;
                const ci = e.ci95_at_headline_budget[r.key];
                return (
                  <tr key={r.key} className={r.ours ? "bg-accent/40" : undefined}>
                    <td className="py-2">
                      <span className="flex items-center gap-2">
                        <span
                          className="size-2.5 shrink-0 rounded-sm"
                          style={{ background: r.chart }}
                        />
                        <span className={r.ours ? "font-semibold" : undefined}>{r.label}</span>
                      </span>
                      <span className="mt-0.5 block pl-4.5 text-xs text-muted-foreground">
                        {r.blurb}
                      </span>
                    </td>
                    <td
                      className={`tabular py-2 text-right font-medium ${
                        r.ours ? "text-[var(--positive)]" : ""
                      }`}
                    >
                      {rupees(v, { compact: true })}
                    </td>
                    <td className="tabular py-2 text-right text-xs text-muted-foreground">
                      {ci ? `${rupees(ci[0], { compact: true })} – ${rupees(ci[1], { compact: true })}` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-4 border-t pt-3">
          <h3 className="text-xs font-medium">Paired difference vs Delta, bootstrap 95% CI</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Paired on the same test items, so the comparison is not confounded by which items each
            strategy happened to draw. A CI excluding zero is the claim that the difference is real.
          </p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {Object.entries(e.paired_diff_ci95).map(([k, d]) => {
              const meta = RANKERS.find((r) => r.key === k);
              return (
                <li key={k} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                  <span className="w-48 shrink-0 text-muted-foreground">
                    {meta?.label ?? k}
                  </span>
                  <span className="tabular font-mono">
                    +{rupees(d.mean, { compact: true })}
                  </span>
                  <span className="tabular font-mono text-muted-foreground">
                    [{rupees(d.lo, { compact: true })}, {rupees(d.hi, { compact: true })}]
                  </span>
                  {d.excludes_zero && (
                    <span className="rounded bg-[var(--positive-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--positive)]">
                      excludes zero
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      {/* ── Floor and ceiling ────────────────────────────────────────── */}
      <section className="animate-rise panel p-5">
        <h2 className="text-sm font-semibold">Floor and ceiling</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Unconstrained by budget. Do-nothing is the floor by construction — it is what the money
          does with no agent at all. Perfect foresight is the ceiling nothing can beat.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Bound
            label="Do nothing"
            value={rupees(e.unconstrained.do_nothing.net_incremental_paise)}
            detail={`${count(e.unconstrained.do_nothing.items)} items, 0 contacts. The floor.`}
          />
          <Bound
            label="Contact everyone"
            value={rupees(contactAll.net_incremental_paise, { compact: true })}
            detail={`${count(contactAll.contacts)} contacts, ${count(contactAll.wasted_contacts)} wasted.`}
          />
          <Bound
            label="Perfect foresight"
            value={rupees(oracle.net_incremental_paise, { compact: true })}
            detail={`${count(oracle.contacts)} contacts. The ceiling.`}
            tone="positive"
          />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Note that perfect foresight beats contact-everything by only{" "}
          {rupees(oracle.net_incremental_paise - contactAll.net_incremental_paise, {
            compact: true,
          })}
          . With an unlimited budget there is little to win — which is exactly why the constrained
          comparison above is the honest one.
        </p>
      </section>

      {/* ── Where it loses, and the caveat ───────────────────────────── */}
      <section className="animate-rise panel p-5">
        <h2 className="text-sm font-semibold">What this evaluation does not prove</h2>
        <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-4 text-sm text-muted-foreground">
          <li>
            <strong className="text-foreground">The data is ours.</strong> These items come from{" "}
            <code className="font-mono text-xs">eval/generate.py</code> at seed {e.seed}, not from
            production traffic. The do-nothing floor and the oracle ceiling are deliberately
            self-punishing, and the generating process is published — but a synthetic world is
            still a world we chose.
          </li>
          <li>
            <strong className="text-foreground">Rankers here use true uplift.</strong> The figures
            compare <em>allocation strategies</em> given a correct score. A miscalibrated model
            would degrade Delta specifically, because it multiplies probability by rupees.
          </li>
          <li>
            <strong className="text-foreground">Compliance costs revenue.</strong>{" "}
            {count(e.compliance_blocked_items)} items worth{" "}
            {rupees(e.compliance_blocked_paise, { compact: true })} were blocked by quiet hours,
            fatigue caps and risk rules. That is money deliberately left on the table, counted
            against us rather than quietly excluded.
          </li>
        </ul>
        <p className="mt-3 border-t pt-2.5 font-mono text-[10px] text-muted-foreground/70">
          {e.note}
        </p>
        <p className="mt-1.5 font-mono text-[10px] text-muted-foreground/70">
          eval/results.json · seed {e.seed} · n={count(e.test_items)} ·{" "}
          {rupees(e.test_amount_at_risk_paise, { compact: true })} at risk · contact cost{" "}
          {rupees(e.contact_cost_paise)}
        </p>
      </section>
    </div>
  );
}

function Headline({
  value,
  label,
  detail,
  tone = "positive",
}: {
  value: string;
  label: string;
  detail: string;
  tone?: "positive" | "notice";
}) {
  return (
    <div className="animate-rise panel p-5">
      <p
        className={`tabular text-3xl leading-none font-semibold tracking-tight ${
          tone === "positive" ? "text-[var(--positive)]" : "text-[var(--notice)]"
        }`}
      >
        {value}
      </p>
      <p className="mt-1.5 text-sm font-medium">{label}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function Bound({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "positive";
}) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`tabular mt-1 text-lg font-semibold ${
          tone === "positive" ? "text-[var(--positive)]" : ""
        }`}
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}
