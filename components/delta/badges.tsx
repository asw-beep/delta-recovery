import { cn } from "@/lib/utils";
import { ACTION_LABEL, humanise, TAXONOMY_LABEL } from "@/lib/format";

/**
 * Status is never carried by colour alone — every badge here pairs its colour
 * with a word, and the LIVE/SIM pair additionally differ in shape. A reviewer
 * skimming a screenshot in greyscale must still be able to tell a real
 * Razorpay call from a simulated one.
 */

const base =
  "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap";

export function VerdictBadge({ verdict, className }: { verdict: string; className?: string }) {
  const tone: Record<string, string> = {
    ALLOW: "bg-[var(--positive-bg)] text-[var(--positive)]",
    DELAY: "bg-[var(--notice-bg)] text-[var(--notice)]",
    ESCALATE: "bg-[var(--info-bg)] text-[var(--info)]",
    STOP: "bg-muted text-muted-foreground",
  };
  return (
    <span className={cn(base, tone[verdict] ?? "bg-muted text-muted-foreground", className)}>
      <Dot verdict={verdict} />
      {verdict}
    </span>
  );
}

function Dot({ verdict }: { verdict: string }) {
  const fill: Record<string, string> = {
    ALLOW: "bg-[var(--positive)]",
    DELAY: "bg-[var(--notice)]",
    ESCALATE: "bg-[var(--info)]",
    STOP: "bg-muted-foreground",
  };
  return <span className={cn("size-1.5 rounded-full", fill[verdict] ?? "bg-muted-foreground")} />;
}

/**
 * LIVE and SIM are the most consequential labels in the product: one spent real
 * money at Razorpay, the other did not. Square vs pill, filled vs hatched.
 */
export function ModeBadge({ mode, className }: { mode: string | null; className?: string }) {
  if (!mode) return null;
  if (mode === "live") {
    return (
      <span
        className={cn(
          base,
          "rounded-sm bg-[var(--positive)] text-white uppercase tracking-wide",
          className,
        )}
      >
        <span className="size-1.5 rounded-full bg-white/90" />
        Live
      </span>
    );
  }
  return (
    <span
      className={cn(
        base,
        "rounded-full border border-dashed border-[var(--notice)] text-[var(--notice)] uppercase tracking-wide",
        className,
      )}
      style={{
        backgroundImage:
          "repeating-linear-gradient(45deg, color-mix(in oklab, var(--notice) 10%, transparent) 0 4px, transparent 4px 8px)",
      }}
    >
      Sim
    </span>
  );
}

export function ActionBadge({ action, className }: { action: string; className?: string }) {
  // Outward actions read as active; decisions that contact nobody stay quiet.
  const outward = ["ISSUE_RECOVERY_LINK", "NUDGE_SMS", "NUDGE_EMAIL", "CHASE_INVOICE"].includes(
    action,
  );
  return (
    <span
      className={cn(
        base,
        outward
          ? "bg-accent text-[var(--accent-foreground)]"
          : "bg-muted text-muted-foreground",
        className,
      )}
    >
      {ACTION_LABEL[action] ?? humanise(action)}
    </span>
  );
}

export function TaxonomyBadge({ cls, className }: { cls: string; className?: string }) {
  const tone: Record<string, string> = {
    TRANSIENT: "bg-[var(--info-bg)] text-[var(--info)]",
    CUSTOMER_FIXABLE: "bg-[var(--positive-bg)] text-[var(--positive)]",
    INSTRUMENT_DEAD: "bg-[var(--negative-bg)] text-[var(--negative)]",
    DO_NOT_TOUCH: "bg-[var(--negative-bg)] text-[var(--negative)]",
    OPAQUE: "bg-muted text-muted-foreground",
  };
  return (
    <span className={cn(base, tone[cls] ?? "bg-muted text-muted-foreground", className)}>
      {TAXONOMY_LABEL[cls] ?? cls}
    </span>
  );
}

export function StateBadge({ state, className }: { state: string; className?: string }) {
  const tone: Record<string, string> = {
    open: "bg-[var(--notice-bg)] text-[var(--notice)]",
    in_progress: "bg-[var(--info-bg)] text-[var(--info)]",
    recovered: "bg-[var(--positive-bg)] text-[var(--positive)]",
    closed: "bg-muted text-muted-foreground",
  };
  return (
    <span className={cn(base, tone[state] ?? "bg-muted text-muted-foreground", className)}>
      {humanise(state)}
    </span>
  );
}
