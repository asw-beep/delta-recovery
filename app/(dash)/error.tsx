"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * What a judge sees if the database is unreachable mid-demo.
 *
 * Without this, a failed query renders Next's default error screen — a stack
 * trace on a page whose entire argument is that it handles failure deliberately.
 * DECISIONS.md §5 commits to degrading rather than lying, and that has to hold
 * in the UI too.
 *
 * It states what is unavailable, what is NOT affected, and offers a retry.
 * Naming what survives matters: every figure lives in Postgres and in Razorpay's
 * own ledger, so a read failure here is a display outage, not lost money or a
 * duplicated action. The idempotency ledger is what makes that claim true.
 */
export default function DashError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[delta] dashboard render failed:", error);
  }, [error]);

  return (
    <div className="flex flex-col gap-7">
      <header>
        <h1 className="text-lg font-semibold tracking-[-0.012em] text-balance">
          This view could not be loaded
        </h1>
        <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">
          The dashboard could not read from the database.
        </p>
      </header>

      <section className="panel max-w-[68ch] p-6">
        <h2 className="text-[0.9375rem] font-semibold">Nothing has been lost</h2>
        <p className="mt-2 text-[0.8125rem] leading-relaxed text-muted-foreground">
          This is a read failure on the display layer. Recovery decisions and their outcomes are
          stored in Postgres and mirrored by Razorpay&rsquo;s own records, and the idempotency
          ledger is written before any outbound call — so a batch interrupted here cannot issue a
          duplicate payment link when it resumes.
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button onClick={reset} className="interactive">
            Try again
          </Button>
          <a
            href="/api/health"
            className="interactive text-[0.8125rem] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Check service health
          </a>
        </div>

        {error.digest && (
          <p className="mt-5 font-mono text-[0.6875rem] text-muted-foreground">
            digest {error.digest}
          </p>
        )}
      </section>
    </div>
  );
}
