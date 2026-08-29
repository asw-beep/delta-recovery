import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shown while a dashboard page's server queries run.
 *
 * Every surface here is a server component reading Supabase through the pooler
 * in ap-southeast-1, so a navigation costs a real round trip and the page was
 * previously blank until it returned. That reads as a broken link rather than as
 * work in progress.
 *
 * The shapes deliberately trace the overview's real layout — one dominant
 * figure, a divider, a three-up rail, then the panel grid — so content arrives
 * into the space its placeholder already occupied instead of shifting it. A
 * spinner cannot do that, which is why the skeleton component was already in the
 * repo and is finally used.
 */
export default function DashLoading() {
  return (
    <div className="flex flex-col gap-7" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="mt-2 h-3.5 w-72" />
        </div>
        <Skeleton className="h-3.5 w-28" />
      </header>

      {/* The headline figure and its rail. */}
      <section className="panel-raised grid gap-y-7 p-6 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.15fr)] lg:gap-x-8 lg:p-7">
        <div>
          <Skeleton className="h-3 w-52" />
          <Skeleton className="mt-3.5 h-11 w-56" />
          <Skeleton className="mt-3 h-3 w-64" />
        </div>

        <div className="hidden w-px bg-border lg:block" />

        <div className="grid gap-6 sm:grid-cols-3 lg:gap-5">
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-2.5 h-7 w-24" />
              <Skeleton className="mt-2 h-3 w-28" />
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="panel p-5 lg:col-span-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-2 h-3 w-full max-w-[46ch]" />
          <div className="mt-5 flex flex-col gap-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-3.5 flex-1" />
                <Skeleton className="h-3.5 w-16" />
              </div>
            ))}
          </div>
        </div>

        <div className="panel p-5 lg:col-span-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-5 h-36 w-full" />
        </div>
      </div>
    </div>
  );
}
