import "dotenv/config";
import { runBatch } from "../lib/batch";

/**
 * Runs one recovery batch.
 *
 *   npx tsx scripts/run-batch.ts --dry                 decide, execute nothing
 *   npx tsx scripts/run-batch.ts --budget 50 --live 2  50 contacts, 2 of them real
 *
 * `--live` bounds how many real Razorpay payment links this run may create.
 * Test Mode caps them per business (DECISIONS.md §3), so the remainder execute
 * as SIM and are labelled as such everywhere they appear.
 */

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function rupees(paise: number): string {
  return `Rs ${(paise / 100).toLocaleString("en-IN")}`;
}

async function main() {
  const dryRun = process.argv.includes("--dry");
  const contactBudget = Number(arg("budget", "50"));
  const liveBudget = arg("live") === undefined ? undefined : Number(arg("live"));

  console.log(`\nbatch: budget=${contactBudget} live=${liveBudget ?? "auto"}${dryRun ? " DRY RUN" : ""}\n`);

  const started = Date.now();
  const s = await runBatch({ contactBudget, liveBudget, dryRun });

  console.log(`considered        ${s.considered} open risk items`);
  console.log(`targeted          ${rupees(s.amountTargetedPaise)}`);
  console.log("");

  if (s.degradation.clusters > 0) {
    console.log(`degradation       ${s.degradation.clusters} cluster(s), ` +
      `${s.degradation.deferredItems} item(s) held back, llm=${s.degradation.llmUsed}`);
    for (const f of s.degradation.findings) {
      console.log(`  ${f.id}`);
      console.log(`    ${f.count} failures, ${f.rateMultiple}x baseline, downtime=${f.downtimeCorroborated}`);
      console.log(`    ${f.cause} -> ${f.disposition}${f.overridden ? "  [EVIDENCE OVERRODE MODEL]" : ""}`);
    }
    console.log("");
  }

  console.log("decisions");
  for (const [verdict, n] of Object.entries(s.decisions)) {
    console.log(`  ${verdict.padEnd(10)} ${n}`);
  }

  if (Object.keys(s.blockedByRule).length > 0) {
    console.log("\nwhy nothing happened, by rule");
    for (const [rule, n] of Object.entries(s.blockedByRule)) {
      console.log(`  ${String(n).padStart(3)}x  ${rule.slice(0, 96)}`);
    }
  }

  console.log("\nexecuted");
  console.log(`  live       ${s.executed.live}   (real Razorpay calls)`);
  console.log(`  sim        ${s.executed.sim}`);
  console.log(`  duplicate  ${s.executed.duplicate}`);
  console.log(`  settled    ${s.executed.abortedSettled}   (money arrived first, stood down)`);
  console.log(`  failed     ${s.executed.failed}`);
  console.log(`\n${Date.now() - started}ms  batch ${s.batchId}\n`);
}

void main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
