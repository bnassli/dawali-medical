import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db/client";
import * as password from "@/lib/password";
import { AuthenticationError, login } from "@/modules/auth/service";
import { createTestUser, openTestDb, uniqueEmail } from "./helpers";

// Pass-through spies: real Argon2 behaviour, but calls are counted.
vi.mock("@/lib/password", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/password")>();
  return {
    ...actual,
    hashPassword: vi.fn(actual.hashPassword),
    verifyPassword: vi.fn(actual.verifyPassword),
  };
});

/** "$argon2id$v=19$m=19456,t=2,p=1" — algorithm, version and cost params. */
function argonParams(hash: string): string {
  return hash.split("$").slice(0, 4).join("$");
}

// Regression (PR #1 review): the unknown-email path used to hash a new dummy
// password and then verify it (two Argon2 operations) while a known account
// did one verification — a measurable timing difference and double CPU work.
describe("login timing parity", () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(() => {
    const opened = openTestDb();
    db = opened.db;
    close = opened.close;
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(() => {
    vi.mocked(password.hashPassword).mockClear();
    vi.mocked(password.verifyPassword).mockClear();
  });

  it("dummy hash is a single precomputed Argon2id hash with the real parameters", async () => {
    const user = await createTestUser(db, { roleCode: "RECEPTION" });
    const realHash = await password.hashPassword(user.password);

    const dummy1 = await password.getDummyPasswordHash();
    const dummy2 = await password.getDummyPasswordHash();

    expect(dummy1).toBe(dummy2); // computed once, reused
    expect(dummy1.startsWith("$argon2id$")).toBe(true);
    expect(argonParams(dummy1)).toBe(argonParams(realHash));
  });

  it("unknown email performs exactly one verification and no hashing", async () => {
    await password.getDummyPasswordHash(); // already warmed at module load
    vi.mocked(password.hashPassword).mockClear();
    vi.mocked(password.verifyPassword).mockClear();

    await expect(
      login(db, { email: uniqueEmail("ghost"), password: "whatever123" }, {}),
    ).rejects.toBeInstanceOf(AuthenticationError);

    expect(password.verifyPassword).toHaveBeenCalledTimes(1);
    expect(password.hashPassword).not.toHaveBeenCalled();
    expect(vi.mocked(password.verifyPassword).mock.calls[0]?.[0]).toBe(
      await password.getDummyPasswordHash(),
    );
  });

  it("known email with a wrong password performs exactly one verification and no hashing", async () => {
    const user = await createTestUser(db, { roleCode: "RECEPTION" });
    vi.mocked(password.hashPassword).mockClear();
    vi.mocked(password.verifyPassword).mockClear();

    await expect(
      login(db, { email: user.email, password: "totally-wrong-password" }, {}),
    ).rejects.toBeInstanceOf(AuthenticationError);

    expect(password.verifyPassword).toHaveBeenCalledTimes(1);
    expect(password.hashPassword).not.toHaveBeenCalled();
  });

  it("the dummy hash never authenticates", async () => {
    const dummy = await password.getDummyPasswordHash();
    for (const guess of ["", "password", "dummy-password-for-timing-parity"]) {
      expect(await password.verifyPassword(dummy, guess)).toBe(false);
    }
  });
});
