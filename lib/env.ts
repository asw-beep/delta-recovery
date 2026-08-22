import { z } from "zod";

/**
 * Env is parsed lazily and cached, never at module load.
 *
 * Eager parsing breaks `next build`, which imports modules without runtime
 * secrets present. Route handlers and scripts call `env()` at request time,
 * where the values genuinely exist.
 */
const Schema = z.object({
  // Razorpay — Test Mode
  RAZORPAY_KEY_ID: z.string().min(1),
  RAZORPAY_KEY_SECRET: z.string().min(1),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1),

  // Database
  DATABASE_URL: z.string().url(),

  // App. Accepts a bare host and normalises it — a missing protocol is a very
  // common deployment typo and must never be able to break payment ingestion.
  APP_URL: z
    .string()
    .default("http://localhost:3000")
    .transform((v) => {
      const t = v.trim().replace(/\/$/, "");
      if (!t) return "http://localhost:3000";
      return /^https?:\/\//i.test(t) ? t : `https://${t}`;
    })
    .pipe(z.string().url()),
  CRON_SECRET: z.string().optional(),

  /**
   * How many real Razorpay payment links a batch may create.
   * Test Mode caps links per business, so the remainder of any batch executes
   * as SIM. See DECISIONS.md §3.
   */
  LIVE_ACTION_BUDGET: z.coerce.number().int().nonnegative().default(12),

  // Optional — the system degrades gracefully without each of these.
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().default("Delta <onboarding@resend.dev>"),
});

export type Env = z.infer<typeof Schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${missing}`);
  }
  cached = parsed.data;
  return cached;
}

/** True when a capability's keys are present. Callers must have a fallback path. */
export const has = {
  gemini: () => Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY),
  groq: () => Boolean(process.env.GROQ_API_KEY),
  resend: () => Boolean(process.env.RESEND_API_KEY),
};
