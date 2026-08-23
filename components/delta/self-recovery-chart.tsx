"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ClassStat } from "@/lib/dash/rankers";
import { RISK_CLASS_LABEL } from "@/lib/format";

/**
 * The differentiator, in one figure.
 *
 * These two quantities stack exactly: `P(pay | no contact)` is the share that
 * arrives for free, and uplift is `P(pay | contact) − P(pay | no contact)`, so
 * the two together are the recovery rate when you do contact. Splitting the bar
 * that way makes the argument visible — the grey run is money that was coming
 * anyway, and only the blue tip is purchasable.
 *
 * Two series, so a legend is mandatory; both are also directly labelled, which
 * means identity never rests on colour alone.
 */

const SELF = "var(--chart-5)";
const LIFT = "var(--chart-1)";

interface Row {
  label: string;
  self: number;
  lift: number;
  total: number;
  n: number;
}

export function SelfRecoveryChart({ byClass }: { byClass: Record<string, ClassStat> }) {
  const data: Row[] = Object.entries(byClass)
    .map(([cls, s]) => ({
      label: RISK_CLASS_LABEL[cls] ?? cls,
      self: s.mean_self_recovery,
      lift: s.mean_uplift,
      total: s.mean_self_recovery + s.mean_uplift,
      n: s.n,
    }))
    .sort((a, b) => b.self - a.self);

  return (
    <div className="mt-4">
      {/* Legend above the plot, in text ink — never in the series colour. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: SELF }} />
          Recovers with no contact
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: LIFT }} />
          Incremental from contacting
        </span>
      </div>

      <ResponsiveContainer width="100%" height={data.length * 56 + 28}>
      {/* Entrance animation is off deliberately. Recharts restarts it on every
          ResponsiveContainer resize — font swap, sidebar reflow, a scroll that
          remounts — so the chart intermittently reads as empty. The section's
          own rise animation already covers arrival; the marks themselves are
          drawn once and stay drawn. */}
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 0, right: 44, bottom: 4, left: 0 }}
          barCategoryGap={16}
        >
          <CartesianGrid
            horizontal={false}
            stroke="var(--border)"
            strokeDasharray="2 4"
          />
          <XAxis
            type="number"
            domain={[0, 1]}
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={132}
            tick={{ fill: "var(--foreground)", fontSize: 12 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: "var(--muted)", opacity: 0.5 }}
            content={<ClassTooltip />}
          />
          {/* 2px surface gap between stacked segments, per the mark spec. */}
          <Bar dataKey="self" stackId="a" isAnimationActive={false} fill={SELF} radius={[4, 0, 0, 4]} barSize={18}>
            <LabelList
              dataKey="self"
              position="insideLeft"
              offset={8}
              formatter={(v) => (Number(v) > 0.14 ? `${Math.round(Number(v) * 100)}%` : "")}
              style={{ fill: "var(--background)", fontSize: 11, fontWeight: 600 }}
            />
          </Bar>
          <Bar dataKey="lift" stackId="a" isAnimationActive={false} fill={LIFT} radius={[0, 4, 4, 0]} barSize={18}>
            {data.map((d) => (
              <Cell key={d.label} stroke="var(--card)" strokeWidth={2} />
            ))}
            <LabelList
              dataKey="total"
              position="right"
              offset={8}
              formatter={(v) => `${Math.round(Number(v) * 100)}%`}
              style={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {/* Table view — the chart is not the only way to read these numbers. */}
      <table className="sr-only">
        <caption>Self-recovery and incremental uplift by risk class</caption>
        <thead>
          <tr>
            <th>Risk class</th>
            <th>Recovers with no contact</th>
            <th>Incremental from contacting</th>
            <th>Items</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <td>{d.label}</td>
              <td>{(d.self * 100).toFixed(1)}%</td>
              <td>{(d.lift * 100).toFixed(1)}%</td>
              <td>{d.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClassTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: Row }[];
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-md border bg-popover p-2.5 text-xs elevation-high">
      <p className="font-semibold">{d.label}</p>
      <dl className="mt-1.5 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
        <dt className="text-muted-foreground">Recovers on its own</dt>
        <dd className="tabular text-right font-medium">{(d.self * 100).toFixed(1)}%</dd>
        <dt className="text-muted-foreground">Contacting adds</dt>
        <dd className="tabular text-right font-medium" style={{ color: LIFT }}>
          +{(d.lift * 100).toFixed(1)}%
        </dd>
        <dt className="text-muted-foreground">Items</dt>
        <dd className="tabular text-right font-medium">{d.n}</dd>
      </dl>
    </div>
  );
}
