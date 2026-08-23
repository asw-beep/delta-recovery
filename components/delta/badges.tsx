import { cn } from "@/lib/utils";
import { ACTION_LABEL, humanise, TAXONOMY_LABEL } from "@/lib/format";

/**
 * One badge, spent deliberately.
 *
 * An earlier version gave every dimension — verdict, action, mode, state,
 * taxonomy — the same filled-pill treatment, so a single table row carried four
 * competing chips and none of them read as a signal. Only two things here are
 * allowed to be a filled badge:
 *
 *   ModeBadge   — LIVE vs SIM, the difference between money moving and not
 *   VerdictBadge — what the policy engine decided
 *
 * Everything else is typography: a coloured dot, small caps, or plain text in
 * the appropriate ink. Status is still never carried by colour alone — every
 * mark below pairs its colour with a word.
 */

/* ── The two real badges ──────────────────────────────────────────────── */

const badge =
  "inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[0.6875rem] font-medium leading-[1.4] whitespace-nowrap";

export function VerdictBadge({ verdict, className }: { verdict: string; className?: string }) {
  const tone: Record<string, string> = {
    ALLOW: "text-[var(--positive)] bg-[var(--positive-bg)]",
    DELAY: "text-[var(--notice)] bg-[var(--notice-bg)]",
    ESCALATE: "text-[var(--info)] bg-[var(--info-bg)]",
    STOP: "text-muted-foreground bg-muted",
  };
  return (
    <span className={cn(badge, tone[verdict] ?? "text-muted-foreground bg-muted", className)}>
      {verdict}
    </span>
  );
}

/**
 * The most consequential label in the product: one of these spent real money at
 * Razorpay and the other did not. They differ in fill, in shape and in wording,
 * so the distinction survives greyscale, a projector, and a colourblind reader.
 */
export function ModeBadge({ mode, className }: { mode: string | null; className?: string }) {
  if (!mode) return null;

  if (mode === "live") {
    return (
      <span
        className={cn(
          badge,
          "rounded-[3px] bg-[var(--positive)] px-1.5 font-semibold tracking-[0.06em] text-white uppercase",
          className,
        )}
      >
        Live
      </span>
    );
  }

  return (
    <span
      className={cn(
        badge,
        "rounded-full border border-dashed border-[var(--notice)]/70 bg-transparent font-semibold tracking-[0.06em] text-[var(--notice)] uppercase",
        className,
      )}
    >
      Sim
    </span>
  );
}

/* ── Everything else: typography, not chips ───────────────────────────── */

/** The proposed action reads as a sentence fragment, because that is what it is. */
export function ActionLabel({ action, className }: { action: string; className?: string }) {
  const outward = ["ISSUE_RECOVERY_LINK", "NUDGE_SMS", "NUDGE_EMAIL", "CHASE_INVOICE"].includes(
    action,
  );
  return (
    <span
      className={cn(
        "text-[0.8125rem] whitespace-nowrap",
        outward ? "font-medium text-foreground" : "text-muted-foreground",
        className,
      )}
    >
      {ACTION_LABEL[action] ?? humanise(action)}
    </span>
  );
}

/**
 * Lifecycle state. A dot plus a word — enough to scan a column by, quiet enough
 * that it never competes with the verdict beside it.
 */
export function StateDot({ state, className }: { state: string; className?: string }) {
  const fill: Record<string, string> = {
    open: "bg-[var(--notice)]",
    in_progress: "bg-[var(--info)]",
    recovered: "bg-[var(--positive)]",
    closed: "bg-muted-foreground/50",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[0.75rem] whitespace-nowrap text-muted-foreground",
        className,
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", fill[state] ?? "bg-muted-foreground/50")} />
      {humanise(state)}
    </span>
  );
}

/** Failure class. Set as a small-caps label — a category, not an alert. */
export function TaxonomyLabel({ cls, className }: { cls: string; className?: string }) {
  const tone: Record<string, string> = {
    DO_NOT_TOUCH: "text-[var(--negative)]",
    INSTRUMENT_DEAD: "text-[var(--negative)]",
    TRANSIENT: "text-muted-foreground",
    CUSTOMER_FIXABLE: "text-muted-foreground",
    OPAQUE: "text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "text-[0.6875rem] font-medium tracking-[0.07em] uppercase",
        tone[cls] ?? "text-muted-foreground",
        className,
      )}
    >
      {TAXONOMY_LABEL[cls] ?? cls}
    </span>
  );
}

/**
 * Synthetic provenance. Deliberately styled like ModeBadge's SIM variant —
 * dashed, hatched, notice-coloured — because it carries the same kind of
 * warning: what you are looking at did not happen on the real account.
 */
export function SyntheticBadge({ className }: { className?: string }) {
  return (
    <span
      title="Loaded from a synthetic batch — not real Razorpay traffic"
      className={cn(
        badge,
        "rounded-full border border-dashed border-muted-foreground/60 bg-transparent font-semibold tracking-[0.06em] text-muted-foreground uppercase",
        className,
      )}
    >
      Synth
    </span>
  );
}
