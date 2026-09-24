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
