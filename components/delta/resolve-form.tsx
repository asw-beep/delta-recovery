"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { Check } from "lucide-react";
import { resolveEscalation } from "@/app/(dash)/escalations/actions";
import { cn } from "@/lib/utils";

/**
 * Closing an escalation asks two things.
 *
 * "What did you do" closes the case. "Did this need a human at all" is the one
 * that earns its keep: the share judged unnecessary is the false-positive rate
 * of whichever rule raised the case, which is how a claim about compliant
 * escalation becomes a number rather than a promise.
 *
 * The judgement is deliberately not required. A reviewer who has not formed a
 * view should be able to close the case without one, because a forced answer
 * would make the precision figure worse than no figure at all.
 */
export function ResolveForm({ id }: { id: string }) {
  const [necessary, setNecessary] = useState<"yes" | "no" | null>(null);

  return (
    <form action={resolveEscalation} className="rule-t mt-4 flex flex-wrap items-center gap-2 pt-3">
      <input type="hidden" name="id" value={id} />
      {necessary && <input type="hidden" name="necessary" value={necessary} />}

      <input
        name="resolution"
        placeholder="What did you do?"
        aria-label="Resolution note"
        className="interactive h-8 min-w-0 flex-1 rounded-md border bg-card px-2.5 text-[0.8125rem] outline-none placeholder:text-muted-foreground focus:border-[var(--ring)] focus:ring-2 focus:ring-[var(--ring)]/20"
      />

      <fieldset className="flex items-center gap-1">
        <legend className="sr-only">Did this need a human?</legend>
        <span className="mr-1 text-[0.75rem] text-muted-foreground">Needed a human?</span>
        <Choice label="Yes" on={necessary === "yes"} onClick={() => setNecessary(necessary === "yes" ? null : "yes")} />
        <Choice label="No" on={necessary === "no"} onClick={() => setNecessary(necessary === "no" ? null : "no")} />
      </fieldset>

      <Submit />
    </form>
  );
}

function Choice({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "interactive rounded-md border px-2 py-1 text-[0.75rem] font-medium",
        on
          ? "border-[var(--primary)]/40 bg-accent text-[var(--accent-foreground)]"
          : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="interactive inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-[var(--primary)] px-3 text-[0.8125rem] font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
    >
      <Check className="size-3.5" strokeWidth={2.5} />
      {pending ? "Resolving…" : "Resolve"}
    </button>
  );
}
