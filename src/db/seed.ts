import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { getEnv } from "@/lib/env";
import { hashPassword } from "@/lib/password";
import {
  ALL_PERMISSION_CODES,
  PERMISSION_DESCRIPTIONS,
  ROLE_NAMES,
  ROLE_PERMISSIONS,
  ROLES,
} from "@/modules/permissions/constants";
import { permissions, rolePermissions, roles, userRoles, users } from "./schema";
import { createDb } from "./client";

/**
 * Idempotent seed: safe to run repeatedly. Fully recomputes
 * role_permissions from the ROLE_PERMISSIONS constant each run so removing
 * a permission from a role in code also removes it in the database.
 */
export async function seed(connectionString: string): Promise<void> {
  const { db, pool } = createDb(connectionString);
  try {
    // 1. Permissions (idempotent upsert on unique `code`).
    const permissionIdByCode = new Map<string, string>();
    for (const code of ALL_PERMISSION_CODES) {
      const [row] = await db
        .insert(permissions)
        .values({ code, description: PERMISSION_DESCRIPTIONS[code] })
        .onConflictDoUpdate({
          target: permissions.code,
          set: { description: PERMISSION_DESCRIPTIONS[code] },
        })
        .returning();
      if (row) permissionIdByCode.set(code, row.id);
    }

    // 2. Roles (idempotent upsert on unique `code`).
    const roleIdByCode = new Map<string, string>();
    for (const code of Object.values(ROLES)) {
      const [row] = await db
        .insert(roles)
        .values({ code, name: ROLE_NAMES[code] })
        .onConflictDoUpdate({
          target: roles.code,
          set: { name: ROLE_NAMES[code] },
        })
        .returning();
      if (row) roleIdByCode.set(code, row.id);
    }

    // 3. Role -> permission mappings.
    for (const code of Object.values(ROLES)) {
      const roleUuid = roleIdByCode.get(code);
      if (!roleUuid) continue;
      const desiredCodes = ROLE_PERMISSIONS[code];
      const desiredIds = desiredCodes
        .map((c) => permissionIdByCode.get(c))
        .filter((v): v is string => Boolean(v));

      await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleUuid));
      if (desiredIds.length > 0) {
        await db.insert(rolePermissions).values(
          desiredIds.map((permissionId) => ({
            roleId: roleUuid,
            permissionId,
          })),
        );
      }
    }

    // 4. Initial admin user, only if both env vars are provided.
    const env = getEnv();
    if (env.SEED_ADMIN_EMAIL && env.SEED_ADMIN_PASSWORD) {
      const email = env.SEED_ADMIN_EMAIL.trim().toLowerCase();
      const passwordHash = await hashPassword(env.SEED_ADMIN_PASSWORD);

      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`)
        .limit(1);

      let adminId: string;
      if (existing) {
        await db
          .update(users)
          .set({ passwordHash, isActive: true, updatedAt: new Date() })
          .where(eq(users.id, existing.id));
        adminId = existing.id;
      } else {
        const [created] = await db
          .insert(users)
          .values({
            email,
            displayName: "Administrator",
            passwordHash,
            isActive: true,
          })
          .returning();
        if (!created) throw new Error("Failed to create admin user");
        adminId = created.id;
      }

      const adminRoleId = roleIdByCode.get(ROLES.ADMIN);
      if (adminRoleId) {
        await db
          .insert(userRoles)
          .values({ userId: adminId, roleId: adminRoleId })
          .onConflictDoNothing();
      }
      console.log(`Seeded admin user: ${email}`);
    } else if (env.SEED_ADMIN_EMAIL || env.SEED_ADMIN_PASSWORD) {
      throw new Error(
        "Both SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set together to seed the admin user.",
      );
    } else {
      console.log(
        "SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD not set — skipping admin user seed.",
      );
    }

    console.log("Seed complete: permissions, roles, role_permissions.");
  } finally {
    await pool.end();
  }
}
