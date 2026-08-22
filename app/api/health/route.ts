import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Deployment health.
 *
 * Reports which capabilities are wired up and whether the database answers.
 * Values are never returned — only whether each name is present — so this is
 * safe to leave reachable. Exists because a misconfigured environment
 * otherwise surfaces as an opaque 500 on the webhook receiver.
 */
export async function GET() {
  const required = [
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_WEBHOOK_SECRET",
    "DATABASE_URL",
  ] as const;

  const optional = ["GROQ_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "RESEND_API_KEY", "CRON_SECRET"] as const;

  const missing = required.filter((k) => !process.env[k]);
  const present = Object.fromEntries(
    [...required, ...optional].map((k) => [k, Boolean(process.env[k])]),
  );

  let database: { ok: boolean; error?: string; events?: number } = { ok: false };
  if (missing.includes("DATABASE_URL")) {
    database = { ok: false, error: "DATABASE_URL not set" };
  } else {
    try {
      const [row] = await db().execute<{ n: number }>(
        sql`select count(*)::int as n from webhook_events`,
      );
      database = { ok: true, events: Number(row?.n ?? 0) };
    } catch (e) {
      // Message only — never the connection string.
      const msg = e instanceof Error ? e.message : String(e);
      database = { ok: false, error: msg.replace(/postgres(ql)?:\/\/[^\s]+/gi, "<redacted>").slice(0, 160) };
    }
  }

  const ok = missing.length === 0 && database.ok;

  return Response.json(
    {
      ok,
      missingRequired: missing,
      env: present,
      database,
      // Degradation is by design: no LLM keys means template diagnoses, not an outage.
      llm: process.env.GROQ_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY ? "configured" : "will fall back to templates",
    },
    { status: ok ? 200 : 503 },
  );
}
