import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, type Database } from "@/db/client";
import { roles, userRoles, users } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { loadActorContext } from "@/modules/auth/service";
import type { RoleCode } from "@/modules/permissions/constants";
import type { ActorContext } from "@/modules/permissions/types";

export function getTestConnectionString(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set — global-setup.ts should have set it.",
    );
  }
  return url;
}

export function openTestDb(): { db: Database; close: () => Promise<void> } {
  const { db, pool } = createDb(getTestConnectionString());
  return { db, close: () => pool.end() };
}

export function uniqueSuffix(): string {
  return randomUUID().slice(0, 8);
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}.${uniqueSuffix()}@test.dawali.local`;
}

export const TEST_PASSWORD = "Password123!";

export interface TestUser {
  userId: string;
  email: string;
  password: string;
  actor: ActorContext;
}

/**
 * Creates a real user + role assignment against the seeded roles table,
 * then loads its ActorContext the same way the real login flow does
 * (join user_roles -> role_permissions -> permissions), so permission
 * checks in tests exercise the real RBAC wiring rather than a mock.
 */
export async function createTestUser(
  db: Database,
  opts: {
    roleCode: RoleCode;
    email?: string;
    displayName?: string;
    isActive?: boolean;
    password?: string;
  },
): Promise<TestUser> {
  const email = opts.email ?? uniqueEmail(opts.roleCode.toLowerCase());
  const password = opts.password ?? TEST_PASSWORD;
  const passwordHash = await hashPassword(password);

  const [user] = await db
    .insert(users)
    .values({
      email,
      displayName: opts.displayName ?? `Test ${opts.roleCode} ${uniqueSuffix()}`,
      passwordHash,
      isActive: opts.isActive ?? true,
    })
    .returning();
  if (!user) throw new Error("Failed to insert test user");

  const [role] = await db
    .select()
    .from(roles)
    .where(eq(roles.code, opts.roleCode))
    .limit(1);
  if (!role) {
    throw new Error(
      `Role ${opts.roleCode} was not found — did global-setup.ts seed roles?`,
    );
  }

  await db.insert(userRoles).values({ userId: user.id, roleId: role.id });

  // loadActorContext correctly refuses inactive users, so inactive test users
  // get an empty-permission actor (they are only used to exercise login).
  const actor =
    user.isActive
      ? await loadActorContext(db, user.id)
      : { userId: user.id, displayName: user.displayName, permissions: new Set<never>() };
  if (!actor) throw new Error("Failed to load actor context for test user");

  return {
    userId: user.id,
    email,
    password,
    actor: { ...actor, ip: "127.0.0.1", userAgent: "vitest" },
  };
}
