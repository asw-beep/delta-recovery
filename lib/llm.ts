import { generateObject } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { ZodType } from "zod";

/**
 * LLM access, with a provider fallback chain.
 *
 * Groq leads on measured evidence: roughly 2x faster than Gemini and no
 * failures across testing, against a Gemini free tier that intermittently
 * returns capacity errors. Verify both with `npx tsx scripts/check-providers.ts`
 * before demo day — provider catalogues move, and a chain pointing at a
 * decommissioned model fails silently until the moment it is needed.
 *
 * IMPORTANT: `ask` returns null rather than throwing. Every call site must have
 * a non-LLM path, because the recovery loop has to keep working when both
 * providers are down (DECISIONS.md §5).
 *
 * Never put length constraints in an output schema. Gemini does not honour
 * `maxLength` in structured output — it emits a longer string and Zod rejects
 * the whole response. Truncate after parsing instead.
 */

export const MODELS = {
  primary: "openai/gpt-oss-120b",
  fallback: "gemini-3.7-flash",
} as const;

function chain() {
  const out: Array<{ name: string; model: ReturnType<ReturnType<typeof createGroq>> }> = [];
  if (process.env.GROQ_API_KEY) {
    const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
    out.push({ name: `groq:${MODELS.primary}`, model: groq(MODELS.primary) });
  }
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    const google = createGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    });
    out.push({ name: `gemini:${MODELS.fallback}`, model: google(MODELS.fallback) });
  }
  return out;
}

export interface AskResult<T> {
  value: T;
  model: string;
  ms: number;
}

export async function ask<T>(
  schema: ZodType<T>,
  prompt: string,
  opts: { system?: string; timeoutMs?: number } = {},
): Promise<AskResult<T> | null> {
  const providers = chain();
  if (providers.length === 0) return null;

  for (const { name, model } of providers) {
    const started = Date.now();
    try {
      const { object } = await generateObject({
        model,
        schema,
        prompt,
        ...(opts.system ? { system: opts.system } : {}),
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      return { value: object as T, model: name, ms: Date.now() - started };
    } catch {
      // Try the next provider. A total failure returns null and the caller
      // degrades to deterministic output.
    }
  }
  return null;
}

export function llmAvailable(): boolean {
  return chain().length > 0;
}

/**
 * Cache keyed on the shape of a situation rather than its identity.
 *
 * Items in the same taxonomy class, risk class and amount band genuinely share a
 * diagnosis, so a 300-item batch makes roughly 8 calls instead of 300. That
 * keeps free tiers viable and the batch fast enough to run on stage — and
 * identical situations getting identical explanations reads as consistency, not
 * repetition.
 */
const cache = new Map<string, unknown>();

export function amountBand(paise: number): string {
  const rupees = paise / 100;
  if (rupees < 1_000) return "<1k";
  if (rupees < 5_000) return "1k-5k";
  if (rupees < 25_000) return "5k-25k";
  if (rupees < 100_000) return "25k-1L";
  return ">1L";
}

export async function cached<T>(key: string, produce: () => Promise<T | null>): Promise<T | null> {
  if (cache.has(key)) return cache.get(key) as T;
  const value = await produce();
  if (value !== null) cache.set(key, value);
  return value;
}

export function cacheStats() {
  return { entries: cache.size };
}
