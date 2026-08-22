import "dotenv/config";
import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { groq } from "@ai-sdk/groq";
import { z } from "zod";

/**
 * Verifies the LLM fallback chain against the live providers.
 *
 * Provider catalogues change without notice and a chain pointing at a
 * decommissioned model fails silently until the moment it is needed, so this is
 * worth re-running before demo day. See DECISIONS.md §9.
 *
 *   npx tsx scripts/check-providers.ts
 */

const GEMINI_MODEL = "gemini-3.7-flash";
const GROQ_MODEL = "openai/gpt-oss-120b";

/**
 * Mirrors the real diagnosis call: a constrained choice plus one line of prose.
 *
 * Note the absence of a length cap. Gemini does not honour `maxLength` in
 * structured output, so `z.string().max(n)` fails validation reproducibly.
 * Truncate after parsing, never in the schema. See DECISIONS.md §9.
 */
const Probe = z.object({
  recoverable: z.boolean(),
  action: z.enum(["ISSUE_RECOVERY_LINK", "ESCALATE_HUMAN", "STOP"]),
  reason: z.string(),
});

const PROMPT = `A Razorpay card payment of Rs 8,499 failed with
error_reason "card_expired", error_source "bank", error_step "payment_authorization".
The customer has 4 previous successful payments. Decide the single best action.`;

function mask(v: string | undefined): string {
  if (!v) return "MISSING";
  return v.length <= 10 ? "set" : `${v.slice(0, 6)}…${v.slice(-4)} (${v.length} chars)`;
}

async function probe(label: string, model: Parameters<typeof generateObject>[0]["model"]) {
  const started = Date.now();
  try {
    const { object, usage } = await generateObject({
      model,
      schema: Probe,
      prompt: PROMPT,
    });
    const ms = Date.now() - started;
    console.log(`  ${label}  OK  ${ms}ms  tokens=${usage?.totalTokens ?? "?"}`);
    console.log(`      -> ${object.action} | recoverable=${object.recoverable}`);
    console.log(`      -> "${object.reason.slice(0, 120)}"`);
    return true;
  } catch (err) {
    const ms = Date.now() - started;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ${label}  FAILED  ${ms}ms`);
    console.log(`      -> ${msg.split("\n")[0].slice(0, 200)}`);
    return false;
  }
}

async function main() {
  console.log("\nkeys");
  console.log(`  GOOGLE_GENERATIVE_AI_API_KEY  ${mask(process.env.GOOGLE_GENERATIVE_AI_API_KEY)}`);
  console.log(`  GROQ_API_KEY                  ${mask(process.env.GROQ_API_KEY)}`);

  console.log("\nlive calls");
  const gemini = await probe(`gemini  ${GEMINI_MODEL}`, google(GEMINI_MODEL));
  const grq = await probe(`groq    ${GROQ_MODEL}`, groq(GROQ_MODEL));

  console.log("");
  if (gemini && grq) {
    console.log("chain healthy: primary and fallback both reachable");
  } else if (gemini || grq) {
    console.log("DEGRADED: only one provider reachable — the chain still works, but with no redundancy");
  } else {
    console.log("BROKEN: neither provider reachable — diagnosis falls back to template strings");
  }
  process.exit(gemini || grq ? 0 : 1);
}

void main();
