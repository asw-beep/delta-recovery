"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  useTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronRight, Search } from "lucide-react";
import { ActionLabel, ModeBadge, StateDot, SyntheticBadge, VerdictBadge } from "@/components/delta/badges";
import { Money } from "@/components/delta/money";
import type { QueueRow } from "@/lib/dash/queries";
import { count, RISK_CLASS_LABEL } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The exact feature set this table opts into; also the ColumnDef generic. */
const FEATURES = { rowSortingFeature, columnFilteringFeature, globalFilteringFeature };
type Features = typeof FEATURES;

/**
 * The queue, in the order the agent works it.
 *
 * Default sort is net expected value descending, because that ordering *is* the
 * product. Sorting by amount is offered precisely so the difference is visible.
 *
 * Table craft, after review: the header sticks so column meaning survives a
 * scroll; every numeric column is right-aligned with tabular figures so digits
 * form a readable edge; headers never wrap; and the row is a single click
 * target with a chevron rather than a competing "Trace" link in the last cell.
 */

/**
 * Uplift, against a domain that means something.
 *
 * The first version scaled the bar by an arbitrary ×300 and drew it 40px wide,
 * so it encoded nothing a reader could act on. This one fixes the domain at
 * 0–0.40 and marks the policy floor at 0.03 — the threshold below which the
 * engine stops rather than contacts. The bar now answers a real question: is
 * this above the line, and by how much?
 */
const UPLIFT_DOMAIN = 0.4;
const UPLIFT_FLOOR = 0.03;

function UpliftMeter({ value }: { value: number }) {
  const pct = Math.min(100, (value / UPLIFT_DOMAIN) * 100);
  const floorPct = (UPLIFT_FLOOR / UPLIFT_DOMAIN) * 100;
  const below = value < UPLIFT_FLOOR;

  return (
    <div className="flex items-center justify-end gap-2.5">
      <span className="tabular text-[0.8125rem] font-medium">{value.toFixed(3)}</span>
      <span
        className="relative h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted"
        title={`Uplift ${value.toFixed(3)} · policy floor ${UPLIFT_FLOOR} · scale 0–${UPLIFT_DOMAIN}`}
      >
        <span
          className={cn(
            "absolute inset-y-0 left-0 rounded-full",
            below ? "bg-muted-foreground/50" : "bg-[var(--chart-1)]",
          )}
          style={{ width: `${pct}%` }}
        />
        {/* The policy floor, drawn where it actually sits on the scale. */}
        <span
          className="absolute inset-y-0 w-px bg-[var(--notice)]"
          style={{ left: `${floorPct}%` }}
        />
      </span>
    </div>
  );
}

export function QueueTable({ rows }: { rows: QueueRow[] }) {
  const [globalFilter, setGlobalFilter] = useState("");
  const [verdict, setVerdict] = useState<string>("all");

  const filtered = useMemo(
    () => (verdict === "all" ? rows : rows.filter((r) => r.verdict === verdict)),
    [rows, verdict],
  );

  const columns = useMemo<ColumnDef<Features, QueueRow>[]>(
    () => [
      {
        id: "item",
        header: "Item",
        accessorFn: (r: QueueRow) => `${RISK_CLASS_LABEL[r.class] ?? r.class} ${r.sourceEntityId}`,
        cell: ({ row }) => {
          const r = row.original as QueueRow;
          return (
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <span className="truncate text-[0.875rem] font-medium">
                  {RISK_CLASS_LABEL[r.class] ?? r.class}
                </span>
                <StateDot state={r.state} />
                {r.synthetic && <SyntheticBadge />}
              </div>
              <p className="mt-1 truncate font-mono text-[0.6875rem] text-muted-foreground">
                {r.sourceEntityId}
                {r.errorReason ? ` · ${r.errorReason}` : ""}
              </p>
            </div>
          );
        },
      },
      {
        id: "amount",
        header: "At risk",
        accessorFn: (r: QueueRow) => r.amountPaise,
        cell: ({ row }) => (
          <div className="text-right">
            <Money paise={(row.original as QueueRow).amountPaise} size="sm" />
          </div>
        ),
      },
      {
        id: "uplift",
        header: "Uplift",
        accessorFn: (r: QueueRow) => r.uplift ?? -1,
        cell: ({ row }) => {
          const u = (row.original as QueueRow).uplift;
          if (u === null || u === undefined) {
            return <p className="text-right text-[0.75rem] text-muted-foreground">not scored</p>;
          }
          return <UpliftMeter value={u} />;
        },
      },
      {
        id: "ev",
        header: "Net EV",
        accessorFn: (r: QueueRow) => r.evPaise ?? Number.NEGATIVE_INFINITY,
        cell: ({ row }) => {
          const r = row.original as QueueRow;
          if (r.evPaise === null || r.evPaise === undefined) {
            return <p className="text-right text-[0.75rem] text-muted-foreground">—</p>;
          }
          return (
            <div className="text-right">
              <Money
                paise={r.evPaise}
                size="sm"
                className={r.evPaise > 0 ? "text-[var(--positive)]" : "text-muted-foreground"}
              />
              {r.costPaise ? (
                <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">
                  after <Money paise={r.costPaise} size="inherit" muted /> cost
                </p>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "action",
        header: "Proposed",
        accessorFn: (r: QueueRow) => r.proposedAction ?? "",
        enableSorting: false,
        cell: ({ row }) => {
          const r = row.original as QueueRow;
          return r.proposedAction ? (
            <div className="flex flex-wrap items-center gap-2">
              <ActionLabel action={r.proposedAction} />
              <ModeBadge mode={r.mode} />
            </div>
          ) : (
            <span className="text-[0.75rem] text-muted-foreground">not scored</span>
          );
        },
      },
      {
        id: "verdict",
        header: "Policy",
        accessorFn: (r: QueueRow) => r.verdict ?? "",
        enableSorting: false,
        cell: ({ row }) => {
          const r = row.original as QueueRow;
          if (!r.verdict) return <span className="text-[0.75rem] text-muted-foreground">—</span>;
          return (
            <div className="min-w-0">
              <VerdictBadge verdict={r.verdict} />
              {r.reasons?.[0] && (
                <p className="mt-1.5 max-w-[24rem] text-[0.6875rem] leading-relaxed text-muted-foreground">
                  {r.reasons[0]}
                </p>
              )}
            </div>
          );
        },
      },
      {
        id: "open",
        header: "",
        enableSorting: false,
        cell: () => (
          <ChevronRight
            className="size-4 text-muted-foreground/40 transition-colors group-hover:text-foreground"
            strokeWidth={2}
          />
        ),
      },
    ],
    [],
  );

  const table = useTable({
    features: FEATURES,
    columns,
    data: filtered,
    state: { globalFilter },
    onGlobalFilterChange: setGlobalFilter,
    initialState: { sorting: [{ id: "ev", desc: true }] },
  });

  const verdicts = useMemo(() => {
    const seen = new Map<string, number>();
    for (const r of rows) if (r.verdict) seen.set(r.verdict, (seen.get(r.verdict) ?? 0) + 1);
    return [...seen.entries()];
  }, [rows]);

  const shown = table.getRowModel().rows;
  const NUMERIC = new Set(["amount", "uplift", "ev"]);

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            strokeWidth={2}
          />
          <input
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            placeholder="Search payment id, class…"
            aria-label="Search the queue"
            className="interactive h-8 w-60 rounded-md border bg-card pr-2.5 pl-8 text-[0.8125rem] outline-none placeholder:text-muted-foreground focus:border-[var(--ring)] focus:ring-2 focus:ring-[var(--ring)]/20"
          />
        </div>

        <div className="flex items-center gap-1">
          <FilterChip
            label="All"
            n={rows.length}
            active={verdict === "all"}
            onClick={() => setVerdict("all")}
          />
          {verdicts.map(([v, n]) => (
            <FilterChip
              key={v}
              label={v}
              n={n}
              active={verdict === v}
              onClick={() => setVerdict(v)}
            />
          ))}
        </div>

        <span className="tabular ml-auto text-[0.75rem] text-muted-foreground">
          {count(shown.length)} of {count(rows.length)}
        </span>
      </div>

      <div className="panel overflow-hidden">
        {/* The scroll container, not the page, owns the sticky context — so the
            header offset does not depend on whether the mixed-execution notice
            is showing. borderCollapse must be "separate" or sticky cells lose
            their background and their bottom border paints under the rows. */}
        <div className="max-h-[70vh] overflow-auto">
          <table
            className="w-full min-w-[940px]"
            style={{ borderCollapse: "separate", borderSpacing: 0 }}
          >
            <thead className="sticky top-0 z-10">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((header) => {
                    const sortable = header.column.getCanSort();
                    const dir = header.column.getIsSorted();
                    const numeric = NUMERIC.has(header.column.id);
                    return (
                      <th
                        key={header.id}
                        scope="col"
                        className={cn(
                          "bg-card px-4 py-2.5 text-[0.6875rem] font-medium tracking-[0.07em] whitespace-nowrap text-muted-foreground uppercase",
                          "shadow-[inset_0_-1px_0_var(--border)]",
                          numeric ? "text-right" : "text-left",
                        )}
                      >
                        {sortable ? (
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className={cn(
                              "interactive inline-flex items-center gap-1 hover:text-foreground",
                              numeric && "flex-row-reverse",
                              dir && "text-foreground",
                            )}
                          >
                            <table.FlexRender header={header} />
                            {dir === "asc" ? (
                              <ArrowUp className="size-3" strokeWidth={2.5} />
                            ) : dir === "desc" ? (
                              <ArrowDown className="size-3" strokeWidth={2.5} />
                            ) : null}
                          </button>
                        ) : (
                          <table.FlexRender header={header} />
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={columns.length} className="border-t px-4 py-14 text-center">
                    <p className="text-[0.8125rem] font-medium">Nothing matches this filter</p>
                    <p className="mt-1 text-[0.75rem] text-muted-foreground">
                      Clear the search or choose a different verdict.
                    </p>
                  </td>
                </tr>
              )}
              {shown.map((row, i) => {
                const r = row.original as QueueRow;
                return (
                  <tr
                    key={row.id}
                    className="animate-rise group relative transition-colors hover:bg-muted/40"
                    style={{ animationDelay: `${Math.min(i * 22, 260)}ms` }}
                  >
                    {row.getAllCells().map((cell, ci) => (
                      <td
                        key={cell.id}
                        className="border-t px-4 py-3 align-top"
                      >
                        {/* One click target for the whole row: the anchor in the
                            first cell is stretched across it. */}
                        {ci === 0 && r.decisionId ? (
                          <>
                            <Link
                              href={`/decisions/${r.decisionId}`}
                              className="absolute inset-0 rounded-sm"
                              aria-label={`Trace the decision for ${r.sourceEntityId}`}
                            />
                            <table.FlexRender cell={cell} />
                          </>
                        ) : (
                          <table.FlexRender cell={cell} />
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {shown.length > 0 && (
        <p className="max-w-[78ch] text-[0.75rem] leading-relaxed text-muted-foreground">
          Ordered by net expected value. Sort by <strong className="font-medium">At risk</strong> to
          see what a ticket-size ranking would have chased instead — that comparison is the whole
          argument, and the evaluation quantifies it. The orange tick on each uplift bar marks the
          policy floor of {UPLIFT_FLOOR}, below which the engine stops rather than contacts.
        </p>
      )}
    </div>
  );
}

function FilterChip({
  label,
  n,
  active,
  onClick,
}: {
  label: string;
  n: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "interactive inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[0.75rem] font-medium",
        active
          ? "border-[var(--primary)]/40 bg-accent text-[var(--accent-foreground)]"
          : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {label}
      <span className={cn("tabular", active ? "opacity-70" : "opacity-55")}>{n}</span>
    </button>
  );
}
