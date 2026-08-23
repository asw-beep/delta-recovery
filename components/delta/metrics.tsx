"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { count, rupees } from "@/lib/format";
import { Money } from "@/components/delta/money";

/**
 * Metrics with a hierarchy.
 *
 * The previous version rendered four identical tiles, which gave recovered
 * revenue — the entire point of the product — the same visual mass as ₹0.10 of
 * channel spend. Here one figure dominates and the rest support it from a rail,
 * so the screen states its own priority before anything is read.
 *
 * Provenance still matters (every number resolves to rows) but it is no longer
 * printed under each figure: raw column names competed with the number, and one
 * of them wrapped onto two lines. It now lives on hover, where a sceptical
 * reader can find it and a merchant is not made to read it.
 */

/* ── Count-up ─────────────────────────────────────────────────────────── */

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

function useCountUp(target: number, durationMs = 700, enabled = true) {
  // Seeded with the truth so the server-rendered HTML carries real money.
  const [value, setValue] = useState(target);
  const frame = useRef<number>(undefined);
  const ran = useRef(false);

  useIsomorphicLayoutEffect(() => {
    const first = !ran.current;
    ran.current = true;

    const skip =
      !first ||
      !enabled ||
      target === 0 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (skip) {
      setValue(target);
      return;
    }

    // Dropping to zero happens before paint, so the animation never flickers
    // from the answer back to the start.
    setValue(0);
    const start = performance.now();
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

/* ── The headline figure ──────────────────────────────────────────────── */

export function HeroMetric({
  label,
  paise,
  note,
  provenance,
  tone = "gain",
}: {
  label: string;
  paise: number;
  note?: string;
  provenance?: string;
  tone?: "gain" | "neutral";
}) {
  const shown = useCountUp(paise);

  return (
    <div className="flex flex-col justify-center py-1" title={provenance}>
      <p className="text-[0.6875rem] font-medium tracking-[0.09em] text-muted-foreground uppercase">
        {label}
      </p>
      <div className="mt-2.5">
        <Money
          paise={Math.round(shown)}
          size="hero"
          className={tone === "gain" ? "text-[var(--positive)]" : "text-foreground"}
        />
      </div>
      {note && <p className="mt-2.5 max-w-[34ch] text-[0.8125rem] text-muted-foreground">{note}</p>}
    </div>
  );
}

/* ── The supporting rail ──────────────────────────────────────────────── */

export function RailMetric({
  label,
  value,
  format,
  note,
  provenance,
  tone = "default",
}: {
  label: string;
  value: number;
  format: "rupees" | "count";
  note?: string;
  provenance?: string;
  tone?: "default" | "notice" | "muted";
}) {
  const shown = useCountUp(value);
  const rounded = Math.round(shown);

  const ink =
    tone === "notice"
      ? "text-[var(--notice)]"
      : tone === "muted"
        ? "text-muted-foreground"
        : "text-foreground";

  return (
    <div className="flex flex-col gap-1.5 py-0.5" title={provenance}>
      <p className="text-[0.6875rem] font-medium tracking-[0.09em] text-muted-foreground uppercase">
        {label}
      </p>
      {format === "rupees" ? (
        <Money paise={rounded} size="lg" className={ink} />
      ) : (
        <span className={cn("tabular text-2xl leading-none font-semibold tracking-[-0.022em]", ink)}>
          {count(rounded)}
        </span>
      )}
      {note && <p className="text-[0.75rem] leading-snug text-muted-foreground">{note}</p>}
    </div>
  );
}

/** Plain-text money for prose, keeping formatting in one place. */
export function moneyText(paise: number) {
  return rupees(paise);
}
