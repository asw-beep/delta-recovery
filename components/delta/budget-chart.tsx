"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { RANKERS, type BudgetRow } from "@/lib/dash/rankers";
import { rupees } from "@/lib/format";

/**
 * Net incremental revenue against contact budget, for five ways of spending it.
 *
 * The budget is the whole point. Unconstrained, every ranker eventually
 * contacts everyone and they converge; it is only when a merchant can make 300
 * contacts instead of 1,900 that *which* 300 starts to matter. The gap between
 * the blue line and the rest is the product.
 *
 * Four categorical hues, validated against this surface. `random` is drawn as a
 * dashed neutral because it is a reference floor rather than a peer strategy —
 * that also keeps it out of the categorical palette, where a low-chroma grey
 * would have failed the chroma check.
 */
export function BudgetChart({ rows }: { rows: BudgetRow[] }) {
  return (
    <div className="mt-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
        {RANKERS.map((r) => (
          <span key={r.key} className="flex items-center gap-1.5 text-muted-foreground">
            <span
              className="h-0.5 w-4 rounded-full"
              style={{
                background: r.key === "random" ? "transparent" : r.chart,
                borderTop: r.key === "random" ? `2px dashed ${r.chart}` : undefined,
              }}
            />
            <span className={r.ours ? "font-semibold text-foreground" : undefined}>{r.label}</span>
          </span>
        ))}
      </div>

      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="budget"
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            label={{
              value: "Contact budget",
              position: "insideBottom",
              offset: -4,
              style: { fill: "var(--muted-foreground)", fontSize: 11 },
            }}
          />
          <YAxis
            tickFormatter={(v: number) => rupees(v, { compact: true })}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={64}
          />
          <Tooltip content={<BudgetTooltip />} cursor={{ stroke: "var(--border)" }} />
          {RANKERS.map((r) => (
            <Line
              key={r.key}
              type="monotone"
              dataKey={r.key}
              stroke={r.chart}
              strokeWidth={r.ours ? 3 : 2}
              strokeDasharray={r.key === "random" ? "4 4" : undefined}
              dot={{ r: r.ours ? 4 : 3, strokeWidth: 2, stroke: "var(--card)", fill: r.chart }}
              activeDot={{ r: r.ours ? 6 : 5, strokeWidth: 2, stroke: "var(--card)" }}
              isAnimationActive
              animationDuration={640}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>

      <table className="sr-only">
        <caption>Net incremental revenue by contact budget and ranking strategy</caption>
        <thead>
          <tr>
            <th>Contact budget</th>
            {RANKERS.map((r) => (
              <th key={r.key}>{r.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.budget}>
              <td>{row.budget}</td>
              {RANKERS.map((r) => (
                <td key={r.key}>{rupees(row[r.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BudgetTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { dataKey: string; value: number }[];
  label?: number;
}) {
  if (!active || !payload?.length) return null;
  const byKey = new Map(payload.map((p) => [p.dataKey, p.value]));
  const best = RANKERS.find((r) => r.ours);
  const ours = best ? (byKey.get(best.key) ?? 0) : 0;

  return (
    <div className="min-w-56 rounded-md border bg-popover p-2.5 text-xs elevation-high">
      <p className="font-semibold">{label} contacts</p>
      <ul className="mt-1.5 flex flex-col gap-0.5">
        {RANKERS.map((r) => {
          const v = byKey.get(r.key) ?? 0;
          return (
            <li key={r.key} className="flex items-baseline gap-2">
              <span className="size-2 shrink-0 rounded-sm" style={{ background: r.chart }} />
              <span className={r.ours ? "font-medium" : "text-muted-foreground"}>{r.label}</span>
              <span className="tabular ml-auto font-mono">{rupees(v, { compact: true })}</span>
            </li>
          );
        })}
      </ul>
      {ours > 0 && (
        <p className="mt-2 border-t pt-1.5 text-[11px] text-muted-foreground">
          Delta earns{" "}
          <strong className="text-foreground">
            {rupees(ours - (byKey.get("by_amount") ?? 0), { compact: true })}
          </strong>{" "}
          more than ticket-size ranking at this budget.
        </p>
      )}
    </div>
  );
}
