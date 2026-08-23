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

import { ArrowDown, ArrowUp, ChevronsUpDown, ExternalLink, Search } from "lucide-react";
import { ActionBadge, ModeBadge, StateBadge, VerdictBadge } from "@/components/delta/badges";
import type { QueueRow } from "@/lib/dash/queries";
import { count, RISK_CLASS_LABEL, rupees } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The exact feature set this table opts into; also the ColumnDef generic. */
const FEATURES = { rowSortingFeature, columnFilteringFeature, globalFilteringFeature };
type Features = typeof FEATURES;

/**
 * The queue, in the order the agent works it.
 *
 * Default sort is net expected value descending, because that ordering *is* the
 * product: a merchant cannot contact everyone, and ranking by ticket size or by
 * "most likely to pay" both spend the budget on customers who would have paid
 * anyway. Sorting by amount is offered precisely so the difference is visible.
 */
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
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">
                  {RISK_CLASS_LABEL[r.class] ?? r.class}
                </span>
                <StateBadge state={r.state} />
              </div>
              <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
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
          <span className="tabular font-medium">
            {rupees((row.original as QueueRow).amountPaise)}
          </span>
        ),
      },
      {
        id: "uplift",
        header: "Uplift",
        accessorFn: (r: QueueRow) => r.uplift ?? -1,
        cell: ({ row }) => {
          const u = (row.original as QueueRow).uplift;
          if (u === null || u === undefined) {
            return <span className="text-xs text-muted-foreground">—</span>;
          }
          return (
            <div className="flex items-center gap-2">
              <span className="tabular text-xs font-medium">{u.toFixed(3)}</span>
              {/* A 3px meter, not a chart: it makes rank legible down the column. */}
              <span className="h-1 w-10 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-[var(--chart-1)]"
                  style={{ width: `${Math.min(100, u * 300)}%` }}
                />
              </span>
            </div>
          );
        },
      },
      {
        id: "ev",
        header: "Net EV",
        accessorFn: (r: QueueRow) => r.evPaise ?? Number.NEGATIVE_INFINITY,
        cell: ({ row }) => {
          const r = row.original as QueueRow;
          if (r.evPaise === null || r.evPaise === undefined) {
            return <span className="text-xs text-muted-foreground">—</span>;
          }
          return (
            <div>
              <span
                className={cn(
                  "tabular font-medium",
                  r.evPaise > 0 ? "text-[var(--positive)]" : "text-muted-foreground",
                )}
              >
                {rupees(r.evPaise)}
              </span>
              {r.costPaise ? (
                <p className="tabular text-[11px] text-muted-foreground">
                  cost {rupees(r.costPaise)}
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
            <div className="flex flex-wrap items-center gap-1.5">
              <ActionBadge action={r.proposedAction} />
              <ModeBadge mode={r.mode} />
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">not scored</span>
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
          if (!r.verdict) return <span className="text-xs text-muted-foreground">—</span>;
          return (
            <div className="min-w-0">
              <VerdictBadge verdict={r.verdict} />
              {r.reasons?.[0] && (
                <p className="mt-1 line-clamp-2 max-w-[22rem] text-[11px] text-muted-foreground">
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
        cell: ({ row }) => {
          const r = row.original as QueueRow;
          if (!r.decisionId) return null;
          return (
            <Link
              href={`/decisions/${r.decisionId}`}
              className="interactive flex items-center gap-1 text-xs text-[var(--primary)] hover:underline"
            >
              Trace
              <ExternalLink className="size-3" strokeWidth={2} />
            </Link>
          );
        },
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

  return (
    <div className="flex flex-col gap-3">
      {/* Filters in one row above the table. */}
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
            className="interactive h-8 w-64 rounded-md border bg-card pr-2 pl-8 text-sm outline-none placeholder:text-muted-foreground focus:border-[var(--ring)] focus:ring-2 focus:ring-[var(--ring)]/20"
          />
        </div>

        <div className="flex items-center gap-1">
          <FilterChip
            label={`All (${rows.length})`}
            active={verdict === "all"}
            onClick={() => setVerdict("all")}
          />
          {verdicts.map(([v, n]) => (
            <FilterChip
              key={v}
              label={`${v} (${n})`}
              active={verdict === v}
              onClick={() => setVerdict(v)}
            />
          ))}
        </div>

        <span className="ml-auto text-xs text-muted-foreground">
          {count(shown.length)} of {count(rows.length)} items
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card elevation-low">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b">
                {hg.headers.map((header) => {
                  const sortable = header.column.getCanSort();
                  const dir = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      className="px-3 py-2.5 text-left text-xs font-medium text-muted-foreground"
                    >
                      {sortable ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="interactive flex items-center gap-1 hover:text-foreground"
                        >
                          <table.FlexRender header={header} />
                          {dir === "asc" ? (
                            <ArrowUp className="size-3" strokeWidth={2.5} />
                          ) : dir === "desc" ? (
                            <ArrowDown className="size-3" strokeWidth={2.5} />
                          ) : (
                            <ChevronsUpDown className="size-3 opacity-40" strokeWidth={2} />
                          )}
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
          <tbody className="divide-y">
            {shown.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-muted-foreground">
                  Nothing matches this filter.
                </td>
              </tr>
            )}
            {shown.map((row, i) => (
              <tr
                key={row.id}
                className="animate-rise interactive hover:bg-muted/50"
                style={{ animationDelay: `${Math.min(i * 25, 300)}ms` }}
              >
                {row.getAllCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-2.5 align-top">
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {shown.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Ordered by net expected value. Sort by <strong>At risk</strong> to see what a
          ticket-size ranking would have chased instead — that comparison is the whole argument,
          and the evaluation quantifies it.
        </p>
      )}
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "interactive rounded-md border px-2.5 py-1 text-xs font-medium",
        active
          ? "border-[var(--primary)] bg-accent text-[var(--accent-foreground)]"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
