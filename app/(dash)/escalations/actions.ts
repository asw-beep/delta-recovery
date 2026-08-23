"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/lib/db";

/**
 * Resolve one escalation.
 *
 * Two questions, not one. "What did you do" closes the case; "did this need a
 * human at all" is what makes escalation measurable — the share of escalations
 * a reviewer judges unnecessary is the false-positive rate of the rule that
 * raised them, and without it "we escalate compliantly" is an assertion rather
 * than a number.
 *
 * SECURITY NOTE. This product has no authentication by design — a single
 * hardcoded merchant, DECISIONS.md §4 — and Next.js Server Actions are
 * reachable by direct POST, not only through the UI. So this action is
 * effectively public on the deployed URL. It is deliberately bounded to match:
 * it writes a resolution note and a judgement on an already-existing row, and
 * can neither move money, contact anyone, nor reopen a case. Anything with real
 * consequences stays out of an unauthenticated action.
 */
export async function resolveEscalation(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const resolution = String(formData.get("resolution") ?? "").trim();
  const necessary = formData.get("necessary");

  if (!id) return;

  // Guard the write to rows that are actually open, so a replayed POST cannot
  // overwrite a resolution somebody already recorded.
  await db()
    .update(schema.escalations)
    .set({
      resolvedAt: new Date(),
      resolution: resolution.slice(0, 500) || "Resolved without a note",
      wasNecessary: necessary === null ? null : necessary === "yes",
    })
    .where(and(eq(schema.escalations.id, id), isNull(schema.escalations.resolvedAt)));

  revalidatePath("/escalations");
  revalidatePath("/");
}
