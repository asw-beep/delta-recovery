import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * Single pooled client, cached across hot reloads in dev so we don't exhaust
 * Supabase connections. `prepare: false` is required when connecting through
 * Supabase's transaction pooler.
 */
const globalForDb = globalThis as unknown as {
  __deltaSql?: ReturnType<typeof postgres>;
};

function client() {
  if (!globalForDb.__deltaSql) {
    globalForDb.__deltaSql = postgres(env().DATABASE_URL, {
      prepare: false,
      max: 5,
    });
  }
  return globalForDb.__deltaSql;
}

let cached: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function db() {
  if (!cached) cached = drizzle(client(), { schema });
  return cached;
}

export { schema };
