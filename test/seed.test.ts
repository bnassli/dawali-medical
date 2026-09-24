import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { roles, userRoles, users } from "@/db/schema";
import { seed } from "@/db/seed";
import { hashPassword, verifyPassword } from "@/lib/password";
import { getTestConnectionString, openTestDb, uniqueEmail } from "./helpers";

// Regression (PR #1 review): re-running the seed with the bootstrap env vars
// used to reset an existing admin's password and force isActive = true,
// silently restoring a static bootstrap credential or re-enabling a
// deliberately disabled account.
describe("admin seed bootstrap", () => {
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

  async function loadAdmin(email: string) {
    return db.select().from(users).where(eq(users.email, email));
  }

  async function roleCodes(userId: string): Promise<string[]> {
    const rows = await db
      .select({ code: roles.code })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, userId));
    return rows.map((r) => r.code);
  }

  it("creates the admin with the ADMIN role when it does not exist", async () => {
    const email = uniqueEmail("bootstrap");
    await seed(getTestConnectionString(), {
      admin: { email, password: "Bootstrap-Pass-1" },
    });

    const [admin] = await loadAdmin(email);
    expect(admin).toBeDefined();
    expect(admin?.isActive).toBe(true);
    expect(await verifyPassword(admin?.passwordHash ?? "", "Bootstrap-Pass-1")).toBe(true);
    expect(await roleCodes(admin?.id ?? "")).toEqual(["ADMIN"]);
  });

  it("re-running never resets the password, re-activates, or re-grants roles", async () => {
    const email = uniqueEmail("bootstrap");
    await seed(getTestConnectionString(), {
      admin: { email, password: "Bootstrap-Pass-1" },
    });
    const [created] = await loadAdmin(email);
    if (!created) throw new Error("bootstrap did not create the admin");

    // The operator rotates the password, disables the account and removes
    // its role, then the seed runs again with (different) bootstrap values.
    await db
      .update(users)
      .set({ isActive: false, passwordHash: await hashPassword("Operator-Rotated-3") })
      .where(eq(users.id, created.id));
    await db.delete(userRoles).where(eq(userRoles.userId, created.id));
    const [rotated] = await loadAdmin(email);

    await seed(getTestConnectionString(), {
      admin: { email, password: "Bootstrap-Pass-1" },
    });
    await seed(getTestConnectionString(), {
      admin: { email: email.toUpperCase(), password: "Another-Pass-2" },
    });

    const after = await loadAdmin(email);
    expect(after).toHaveLength(1); // no duplicate account
    expect(after[0]?.passwordHash).toBe(rotated?.passwordHash);
    expect(await verifyPassword(after[0]?.passwordHash ?? "", "Operator-Rotated-3")).toBe(true);
    expect(await verifyPassword(after[0]?.passwordHash ?? "", "Bootstrap-Pass-1")).toBe(false);
    expect(after[0]?.isActive).toBe(false);
    expect(after[0]?.updatedAt.getTime()).toBe(rotated?.updatedAt.getTime());
    expect(await roleCodes(created.id)).toEqual([]);
  });
});
