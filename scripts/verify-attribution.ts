import "dotenv/config";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../lib/db";

/**
 * Traces recovered money back to the decision that caused it.
 *
 *   npx tsx scripts/verify-attribution.ts
 *
 * "Measured money recovered" is the bar Track 03 actually sets, and the only
 * thing that makes the figure a measurement rather than a claim is this chain:
 *
 *   decision -> action_attempt (link carrying notes.decision_id)
 *            -> payment_link.paid webhook
 *            -> outcome row citing the event that proved it
 *            -> risk item closed
 *
 * Every link is asserted against the live database. A break is reported at the
 * step it broke, because "no recovery yet" and "recovery not attributed" look
 * identical on a dashboard and are completely different problems.
 */

let pass = 0;
let fail = 0;

function check(ok: boolean, label: string, detail = ""): boolean {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  ok ? pass++ : fail++;
  return ok;
}

function rupees(paise: number): string {
  return `Rs ${(paise / 100).toLocaleString("en-IN")}`;
}

async function main() {
  console.log("\nattribution chain\n");

  // ── Executed contacts that could produce a recovery ──────────────────────
  const attempts = await db()
    .select({
      id: schema.actionAttempts.id,
      decisionId: schema.actionAttempts.decisionId,
      action: schema.actionAttempts.action,
      mode: schema.actionAttempts.mode,
      status: schema.actionAttempts.status,
      entityId: schema.actionAttempts.razorpayEntityId,
      shortUrl: schema.actionAttempts.shortUrl,
      riskItemId: schema.decisions.riskItemId,
      amountPaise: schema.riskItems.amountAtRiskPaise,
      riskState: schema.riskItems.state,
      closedReason: schema.riskItems.closedReason,
    })
    .from(schema.actionAttempts)
    .innerJoin(schema.decisions, eq(schema.decisions.id, schema.actionAttempts.decisionId))
    .innerJoin(schema.riskItems, eq(schema.riskItems.id, schema.decisions.riskItemId))
    .where(eq(schema.actionAttempts.status, "succeeded"))
    .orderBy(desc(schema.actionAttempts.startedAt));

  const live = attempts.filter((a) => a.mode === "live");
  console.log(`${attempts.length} succeeded attempt(s), ${live.length} live\n`);

  if (live.length === 0) {
    console.log("  no live attempt yet — run: npx tsx scripts/run-batch.ts --live 1\n");
    process.exit(1);
  }

  for (const a of live) {
    console.log(`${a.entityId}  ${a.action}  ${rupees(a.amountPaise)}`);
    console.log(`  ${a.shortUrl ?? "(no short_url)"}`);

    // 1. The link must carry the attribution key, or nothing downstream works.
    check(Boolean(a.decisionId), "link carries a decision id", a.decisionId.slice(0, 8));

    // 2. The outcome row — written only by the webhook path.
    const [outcome] = await db()
      .select()
      .from(schema.outcomes)
      .where(eq(schema.outcomes.decisionId, a.decisionId));

    if (!outcome) {
      check(false, "outcome row exists", "not paid yet, or attribution did not fire");
      console.log("");
      continue;
    }

    check(outcome.result === "recovered", "outcome recorded as recovered", outcome.result);
    check(outcome.recoveredAmountPaise > 0, "recovered amount is non-zero", rupees(outcome.recoveredAmountPaise));
    check(
      outcome.recoveredAmountPaise === a.amountPaise,
      "recovered amount matches the amount at risk",
      `${rupees(outcome.recoveredAmountPaise)} vs ${rupees(a.amountPaise)}`,
    );
    check(Boolean(outcome.attributionSource), "attribution source named", outcome.attributionSource ?? "");

    // 3. The proof: a real, signature-valid webhook event, not our own writing.
    if (outcome.verifyingEventId) {
      const [ev] = await db()
        .select({
          event: schema.webhookEvents.event,
          valid: schema.webhookEvents.signatureValid,
          rzpId: schema.webhookEvents.razorpayEventId,
        })
        .from(schema.webhookEvents)
        .where(eq(schema.webhookEvents.id, outcome.verifyingEventId));
      check(Boolean(ev), "verifying webhook event resolves", ev?.rzpId ?? "");
      check(ev?.valid === true, "verifying event passed HMAC", String(ev?.valid));
      check(Boolean(ev?.event), "verifying event named", ev?.event ?? "");
    } else {
      check(false, "outcome cites a verifying webhook event", "null — recovery is unproven");
    }

    // 4. The risk item must be closed, or the queue keeps chasing paid money.
    check(a.riskState !== "open", "risk item no longer open", a.riskState);
    check(
      a.closedReason === "recovered_after_intervention",
      "closed as recovered_after_intervention",
      a.closedReason ?? "(none)",
    );
    console.log("");
  }

  // ── Totals ───────────────────────────────────────────────────────────────
  const recovered = await db()
    .select({
      amount: schema.outcomes.recoveredAmountPaise,
      result: schema.outcomes.result,
    })
    .from(schema.outcomes)
    .where(eq(schema.outcomes.result, "recovered"));
  const total = recovered.reduce((n, r) => n + r.amount, 0);
  console.log(`recovered  ${recovered.length} outcome(s), ${rupees(total)}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
