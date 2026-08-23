import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { LiveDot, SideNav, ThemeToggle } from "@/components/delta/nav";
import { hasSimulatedActions } from "@/lib/dash/queries";

/**
 * The dashboard shell.
 *
 * The SIM banner is not decoration and is not dismissible. Test Mode caps
 * payment links per business, so part of any batch executes as a simulation —
 * and a screenshot of this dashboard must never be mistakable for a claim that
 * every action was real. See DECISIONS.md §2.
 */
export default async function DashLayout({ children }: LayoutProps<"/">) {
  const showSim = await hasSimulatedActions();

  return (
    <div className="flex min-h-full flex-1 flex-col">
      {showSim && (
        <div
          role="status"
          className="flex items-center justify-center gap-2 border-b border-[var(--notice)]/25 bg-[var(--notice-bg)] px-4 py-1.5 text-xs text-[var(--notice)]"
        >
          <TriangleAlert className="size-3.5 shrink-0" strokeWidth={2} />
          <span>
            <strong className="font-semibold">Mixed execution.</strong> Test Mode caps payment
            links, so some actions ran as simulations. Every row is labelled{" "}
            <strong className="font-semibold">LIVE</strong> or{" "}
            <strong className="font-semibold">SIM</strong>; only LIVE touched Razorpay.
          </span>
        </div>
      )}

      <div className="flex flex-1">
        <aside className="hidden w-56 shrink-0 flex-col border-r bg-sidebar md:flex">
          <div className="flex h-14 items-center gap-2 border-b px-5">
            <BrandMark />
          </div>
          <SideNav />
          <div className="mt-auto p-4">
            <p className="text-[10px] leading-relaxed text-muted-foreground/70">
              Every figure on these pages resolves to a database row. Nothing is typed by hand.
            </p>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b bg-background/85 px-5 backdrop-blur-sm">
            <div className="md:hidden">
              <BrandMark />
            </div>
            <div className="ml-auto flex items-center gap-2">
              <LiveDot label="Test Mode · live account" />
              <ThemeToggle />
            </div>
          </header>

          <main className="flex-1 px-5 py-6">
            <div className="mx-auto w-full max-w-[1180px]">{children}</div>
          </main>
        </div>
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
    <Link href="/" className="interactive flex items-center gap-2 hover:opacity-80">
      <span className="flex size-7 items-center justify-center rounded-md bg-[var(--primary)] font-semibold text-[var(--primary-foreground)]">
        Δ
      </span>
      <span className="text-sm leading-none font-semibold tracking-tight">
        Delta
        <span className="ml-1.5 font-normal text-muted-foreground">recovery</span>
      </span>
    </Link>
  );
}
