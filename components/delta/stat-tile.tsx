"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

/**
 * `useLayoutEffect` on the client, `useEffect` on the server.
 *
 * The distinction is the whole point of the hook below, so it is not incidental:
 * state must START at the true figure so the server-rendered HTML carries real
 * money, and must drop to zero BEFORE the browser paints so the animation is
 * not a visible flicker from the answer back to zero. Only a layout effect runs
 * in that window. React warns if you call one during SSR, hence the swap.
 */
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

function useCountUp(target: number, durationMs = 640, enabled = true) {
  // Seeded with the truth, never 0: this is what lands in the SSR payload and
  // what a crawler, a screenshot, or a JS-less load will read. A money surface
  // that server-renders "₹0" is worse than one that never animates.
  const [value, setValue] = useState(target);
  const frame = useRef<number>(undefined);
  const ran = useRef(false);

  useIsomorphicLayoutEffect(() => {
    // Animate once, on first mount. A later change to `target` jumps straight
    // to the new figure rather than re-running the theatre.
    const first = !ran.current;
    ran.current = true;

    const reduce =
      !first ||
      !enabled ||
      target === 0 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduce) {
      setValue(target);
      return;
    }

    setValue(0);
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
