import { randomBytes, createHash } from "node:crypto";

/**
 * Generates a fresh, high-entropy session token. The raw token is what goes
 * into the httpOnly cookie; only its SHA-256 hash is ever persisted, so a
 * database read/leak alone cannot be used to impersonate a session.
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
