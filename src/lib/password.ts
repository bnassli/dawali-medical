import { randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

// @node-rs/argon2 exports `Algorithm` as an ambient `const enum`, which
// can't be imported under isolatedModules (required by Next.js). Argon2id
// is value 2 — see node_modules/@node-rs/argon2/index.d.ts.
const ARGON2ID = 2;

const HASH_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, HASH_OPTIONS);
}

let dummyHash: Promise<string> | undefined;

/**
 * A valid Argon2id hash of a random, never-disclosed secret, computed once
 * per process with the same HASH_OPTIONS as real passwords. Login verifies
 * against it when the email is unknown, so that path costs exactly one
 * verification, the same as a known account, and never hashes.
 */
export function getDummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString("base64url")).catch(
    (err: unknown) => {
      dummyHash = undefined; // allow a retry rather than caching a failure
      throw err;
    },
  );
  return dummyHash;
}

export async function verifyPassword(
  hashValue: string,
  plain: string,
): Promise<boolean> {
  try {
    return await verify(hashValue, plain);
  } catch {
    // Malformed hash, etc. — treat as a failed verification, never throw.
    return false;
  }
}
