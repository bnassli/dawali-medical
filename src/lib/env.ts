import { z } from "zod";

/**
 * Centralised, validated environment configuration.
 *
 * IMPORTANT: this module must be safe to import at build time without a
 * database connection actually being available. It only validates the
 * *shape* of process.env; nothing here opens a socket.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  /**
   * Canonical public origin of the app (scheme + host + optional port, no
   * path), e.g. https://clinic.example.com. State-changing API requests must
   * carry exactly this Origin. REQUIRED in production (the API fails closed
   * without it); in development/test the request's own origin is used.
   */
  APP_ORIGIN: z
    .string()
    .url()
    .refine((v) => /^https?:$/.test(new URL(v).protocol), "APP_ORIGIN must be http(s)")
    .transform((v) => new URL(v).origin)
    .optional(),
  /**
   * IANA time zone of the clinic, used for calendar-date calculations such as
   * a patient's age "today". Defaults to Asia/Riyadh.
   */
  APP_TIME_ZONE: z
    .string()
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "APP_TIME_ZONE must be a valid IANA time zone")
    .default("Asia/Riyadh"),
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(8).optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Lazily parse and cache the environment. Lazy so that `next build` (which
 * imports server modules to trace them) never fails just because
 * DATABASE_URL isn't set in the build environment.
 */
export function getEnv(): Env {
  if (!cached) {
    cached = envSchema.parse(process.env);
  }
  return cached;
}

/**
 * Same as getEnv() but throws a clear error if DATABASE_URL is missing.
 * Use this at the point where a DB connection is actually required
 * (db client factory, migrator, seed script) rather than at import time.
 */
export function getDatabaseUrl(): string {
  const env = getEnv();
  if (!env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and configure it.",
    );
  }
  return env.DATABASE_URL;
}
