import Link from "next/link";

/**
 * Reached most plausibly by opening a decision id that no longer exists — a
 * stale link from a batch that was purged and reloaded, which happens routinely
 * on this account.
 *
 * So it explains that specific cause rather than shrugging, and routes back to
 * the two places a decision can actually be found.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-full flex-1 items-center px-5 py-16 sm:px-7">
      <div className="mx-auto w-full max-w-[68ch]">
        <p className="font-mono text-[0.75rem] tracking-[0.09em] text-muted-foreground uppercase">
          404
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-0.015em] text-balance">
          There is no record at this address
        </h1>
        <p className="mt-3 text-[0.875rem] leading-relaxed text-muted-foreground text-pretty">
          If you followed a link to a decision, that decision may have been removed — the synthetic
          batch is periodically purged and reloaded, which retires the ids that came with it. Live
          decisions and escalations are always reachable from the queue.
        </p>

        <nav className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-[0.875rem]">
          <Link href="/" className="interactive font-medium underline-offset-4 hover:underline">
            Overview
          </Link>
          <Link
            href="/queue"
            className="interactive font-medium underline-offset-4 hover:underline"
          >
            Decision queue
          </Link>
          <Link
            href="/escalations"
            className="interactive font-medium underline-offset-4 hover:underline"
          >
            Escalations
          </Link>
        </nav>
      </div>
    </main>
  );
}
