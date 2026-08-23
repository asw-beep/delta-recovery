"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { count, rupees } from "@/lib/format";

/**
 * A stat tile, not a chart. Per the visualization guidance, a single headline
 * magnitude is better served by a large number than by a plot of one value.
 *
 * The count-up exists to make the figure read as *computed* rather than typed —
 * which is the honest impression, since every value here came out of a query.
 * It runs once, respects prefers-reduced-motion, and never changes the value.
 */

function useCountUp(target: number, durationMs = 640, enabled = true) {
  const [value, setValue] = useState(enabled ? 0 : target);
  const frame = useRef<number>(undefined);

  useEffect(() => {
    // Every path below settles the value from inside a rAF callback rather than
    // synchronously in the effect body, which would cascade a second render.
    const reduce =
      !enabled ||
      target === 0 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduce) {
      frame.current = requestAnimationFrame(() => setValue(target));
      return () => {
        if (frame.current) cancelAnimationFrame(frame.current);
      };
    }

    const start = performance.now();
    // Blade's `entrance` curve, cubic-bezier(0, 0, 0.2, 1), approximated as an
    // ease-out cubic — indistinguishable at this duration and no solver needed.
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(t < 1 ? target * eased : target);
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [target, durationMs, enabled]);

  return value;
}

export interface StatTileProps {
  label: string;
  /** Raw numeric target, used for the count-up. */
  value: number;
  /**
   * Named formatter rather than a function: a Server Component cannot hand a
   * closure across the client boundary, and money formatting must stay in
   * lib/format either way.
   */
  format: "rupees" | "rupeesCompact" | "count";
  sublabel?: string;
  /** Small print naming the rows this number came from. */
  provenance?: string;
  tone?: "default" | "positive" | "notice" | "muted";
  animate?: boolean;
  delayMs?: number;
  className?: string;
}

export function StatTile({
  label,
  value,
  format,
  sublabel,
  provenance,
  tone = "default",
  animate = true,
  delayMs = 0,
  className,
}: StatTileProps) {
  const shown = useCountUp(value, 640, animate);

  const render =
    format === "rupees"
      ? rupees(Math.round(shown))
      : format === "rupeesCompact"
        ? rupees(Math.round(shown), { compact: true })
        : count(Math.round(shown));

  const valueTone = {
    default: "text-foreground",
    positive: "text-[var(--positive)]",
    notice: "text-[var(--notice)]",
    muted: "text-muted-foreground",
  }[tone];

  return (
    <div
      className={cn(
        "animate-rise interactive group relative overflow-hidden rounded-lg border bg-card p-4 elevation-low hover:elevation-mid",
        className,
      )}
      style={{ animationDelay: `${delayMs}ms` }}
    >
      {/* A hairline in the tile's tone. Razorpay uses these to key a card to a
          status without tinting the whole surface. */}
      {tone !== "default" && (
        <span
          aria-hidden
          className={cn(
            "absolute inset-x-0 top-0 h-0.5",
            tone === "positive" && "bg-[var(--positive)]",
            tone === "notice" && "bg-[var(--notice)]",
            tone === "muted" && "bg-border",
          )}
        />
      )}
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn("tabular mt-1.5 text-2xl leading-none font-semibold tracking-tight", valueTone)}>
        {render}
      </p>
      {sublabel && <p className="mt-1.5 text-xs text-muted-foreground">{sublabel}</p>}
      {provenance && (
        <p className="mt-2 font-mono text-[10px] text-muted-foreground/70">{provenance}</p>
      )}
    </div>
  );
}
