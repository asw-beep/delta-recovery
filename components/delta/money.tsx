import { cn } from "@/lib/utils";
import { rupees } from "@/lib/format";

/**
 * Money, set as money.
 *
 * In a payments product the currency figure is the object the whole screen is
 * about, so it gets its own typographic treatment rather than inheriting a
 * heading's. Three things do the work:
 *
 *   - the ₹ is set smaller and lighter than the digits, so the eye lands on the
 *     magnitude instead of the symbol;
 *   - digits are tabular, so figures stacked in a column align on the decimal;
 *   - tracking tightens as the figure grows, because default letter-spacing
 *     looks loose at display sizes.
 *
 * Splitting the symbol is why this is a component and not a CSS class.
 */

type Size = "hero" | "lg" | "md" | "sm" | "inherit";

const SIZES: Record<Size, { digits: string; symbol: string }> = {
  hero: { digits: "text-[2.75rem] leading-[1.05] font-semibold tracking-[-0.03em]", symbol: "text-[0.5em] mr-[0.12em] font-medium" },
  lg: { digits: "text-2xl leading-none font-semibold tracking-[-0.022em]", symbol: "text-[0.56em] mr-[0.1em] font-medium" },
  md: { digits: "text-base leading-none font-medium tracking-[-0.012em]", symbol: "text-[0.68em] mr-[0.08em]" },
  sm: { digits: "text-[0.8125rem] leading-none font-medium", symbol: "text-[0.75em] mr-[0.08em]" },
  inherit: { digits: "font-medium", symbol: "text-[0.75em] mr-[0.08em]" },
};

export function Money({
  paise,
  size = "md",
  compact,
  className,
  muted,
}: {
  paise: number;
  size?: Size;
  compact?: boolean;
  className?: string;
  /** Dims the symbol further — for secondary figures in a dense column. */
  muted?: boolean;
}) {
  const text = rupees(paise, { compact });
  const symbol = text.slice(0, 1);
  const digits = text.slice(1);
  const s = SIZES[size];

  return (
    <span className={cn("tabular inline-flex items-baseline whitespace-nowrap", s.digits, className)}>
      <span className={cn(s.symbol, muted ? "opacity-45" : "opacity-60")}>{symbol}</span>
      {digits}
    </span>
  );
}
