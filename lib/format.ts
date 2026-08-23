/**
 * Presentation helpers.
 *
 * Money lives in the database as integer paise and is formatted exactly once,
 * here. No component divides by 100 — that is how rounding drift and a wrong
 * rupee figure get into a demo.
 */

/** Rs 8,499 — Indian digit grouping, no decimals unless there are paise. */
export function rupees(paise: number, opts: { compact?: boolean } = {}): string {
  const r = paise / 100;
  if (opts.compact) {
    if (Math.abs(r) >= 10_000_000) return `₹${(r / 10_000_000).toFixed(2)}Cr`;
    if (Math.abs(r) >= 100_000) return `₹${(r / 100_000).toFixed(2)}L`;
    if (Math.abs(r) >= 1_000) return `₹${(r / 1_000).toFixed(1)}K`;
  }
  const hasPaise = paise % 100 !== 0;
  return `₹${r.toLocaleString("en-IN", {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

/** Bare number, Indian grouping — for counts beside a unit label. */
export function count(n: number): string {
  return n.toLocaleString("en-IN");
}

export function percent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** "4 minutes ago". Deterministic input, so it can render on the server. */
export function ago(date: Date, now = new Date()): string {
  const secs = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(secs);
  const fmt = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 60) return fmt.format(Math.round(secs), "second");
  if (abs < 3600) return fmt.format(Math.round(secs / 60), "minute");
  if (abs < 86400) return fmt.format(Math.round(secs / 3600), "hour");
  return fmt.format(Math.round(secs / 86400), "day");
}

export function istTime(date: Date): string {
  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** SCREAMING_SNAKE enum values are unreadable in a table cell. */
export function humanise(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export const RISK_CLASS_LABEL: Record<string, string> = {
  failed_payment: "Failed payment",
  abandoned_checkout: "Abandoned checkout",
  overdue_receivable: "Overdue receivable",
};

export const ACTION_LABEL: Record<string, string> = {
  ISSUE_RECOVERY_LINK: "Issue recovery link",
  NUDGE_SMS: "Nudge · SMS",
  NUDGE_EMAIL: "Nudge · Email",
  CHASE_INVOICE: "Chase invoice",
  DEFER: "Defer",
  WITHDRAW: "Withdraw link",
  ESCALATE_HUMAN: "Escalate to human",
  STOP: "Stop",
};

export const TAXONOMY_LABEL: Record<string, string> = {
  TRANSIENT: "Transient",
  CUSTOMER_FIXABLE: "Customer fixable",
  INSTRUMENT_DEAD: "Instrument dead",
  DO_NOT_TOUCH: "Do not touch",
  OPAQUE: "Opaque",
};

/** Shortens a uuid for display without ever being used as an identifier. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
