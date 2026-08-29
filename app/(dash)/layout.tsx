import Link from "next/link";
import { LiveDot, SideNav, ThemeToggle } from "@/components/delta/nav";
import { hasSimulatedActions, syntheticShare } from "@/lib/dash/queries";

/**
 * The dashboard shell.
 *
 * The mixed-execution notice stays permanent and non-dismissible — Test Mode
 * caps payment links, so part of any batch is simulated and a screenshot of
 * this dashboard must never read as a claim that every action was real
 * (DECISIONS.md §2). What changed is its manners: it was a full-bleed centred
 * tint bar, which is the visual grammar of a cookie consent nag. It now aligns
 * to the content column, sits on a hairline rather than a slab of colour, and
 * leads with the distinction rather than with an alarm.
 */
export default async function DashLayout({ children }: LayoutProps<"/">) {
  const [showSim, syn] = await Promise.all([hasSimulatedActions(), syntheticShare()]);

  return (
    <div className="flex min-h-full flex-1">
      {/* Keyboard users land on the sidebar first and would otherwise tab
          through every nav item on every page to reach the content. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-[var(--primary)] focus:px-3 focus:py-2 focus:text-[0.8125rem] focus:font-medium focus:text-[var(--primary-foreground)]"
      >
        Skip to content
      </a>

      <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar lg:flex">
        <div className="flex h-14 items-center border-b px-5">
          <BrandMark />
        </div>

        {/* Whose money this is. Without it the sidebar could belong to anything. */}
        <div className="border-b px-5 py-3.5">
          <p className="text-[0.6875rem] font-medium tracking-[0.09em] text-muted-foreground uppercase">
            Account
          </p>
          <p className="mt-1.5 truncate text-[0.8125rem] font-medium">Delta Merchant</p>
          <p className="mt-0.5 font-mono text-[0.6875rem] text-muted-foreground">rzp_test_TSn…</p>
        </div>

        <SideNav />

        <div className="mt-auto border-t px-5 py-4">
          <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
            Every figure here resolves to a database row. Hover a number to see which.
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b bg-background/88 px-5 backdrop-blur-md sm:px-7">
          <div className="lg:hidden">
            <BrandMark />
          </div>
          <div className="ml-auto flex items-center gap-2.5">
            <LiveDot label="Test Mode" />
            <ThemeToggle />
          </div>
        </header>

        {showSim && (
          <div className="border-b bg-[var(--notice-bg)]/45">
            <div className="mx-auto flex w-full max-w-[1160px] items-baseline gap-3 px-5 py-2 sm:px-7">
              <span className="shrink-0 text-[0.6875rem] font-semibold tracking-[0.09em] text-[var(--notice)] uppercase">
                Mixed execution
              </span>
              <p className="text-[0.75rem] leading-relaxed text-muted-foreground">
                Test Mode caps payment links, so part of this batch was simulated. Rows marked{" "}
                <span className="font-semibold text-[var(--positive)]">LIVE</span> reached Razorpay;
                rows marked <span className="font-semibold text-[var(--notice)]">SIM</span> did not.
              </p>
            </div>
          </div>
        )}

        {syn.synthetic > 0 && (
          <div className="border-b bg-muted/50">
            <div className="mx-auto flex w-full max-w-[1160px] items-baseline gap-3 px-5 py-2 sm:px-7">
              <span className="shrink-0 text-[0.6875rem] font-semibold tracking-[0.09em] text-muted-foreground uppercase">
                Synthetic traffic
              </span>
              <p className="text-[0.75rem] leading-relaxed text-muted-foreground">
                {syn.synthetic} of {syn.total} items were loaded from a synthetic batch to exercise
                paths this test account has not produced. They are marked{" "}
                <span className="font-semibold">SYNTH</span> and their ids carry{" "}
                <span className="font-mono">SYN</span>. Recovered money on the overview comes only
                from verified Razorpay webhooks.
              </p>
            </div>
          </div>
        )}

        <main id="main" className="flex-1 px-5 py-7 sm:px-7">
          <div className="mx-auto w-full max-w-[1160px]">{children}</div>
        </main>
      </div>
    </div>
  );
}

/**
 * The delta glyph does the naming work: Delta optimises the *incremental*
 * rupee, and that is exactly what the symbol means.
 */
function BrandMark() {
  return (
    <Link href="/" className="interactive flex items-center gap-2.5 hover:opacity-75">
      <span className="flex size-6 items-center justify-center rounded-[5px] bg-[var(--primary)] text-[0.8125rem] leading-none font-semibold text-[var(--primary-foreground)]">
        Δ
      </span>
      <span className="text-[0.9375rem] leading-none font-semibold tracking-[-0.01em]">Delta</span>
    </Link>
  );
}
