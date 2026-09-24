import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { getEnv } from "@/lib/env";
import { hashPassword } from "@/lib/password";
import {
  CLINICAL_SECTIONS,
  isSelectType,
  optionListCode,
} from "@/modules/clinical/definitions";
import {
  ALL_PERMISSION_CODES,
  PERMISSION_DESCRIPTIONS,
  ROLE_NAMES,
  ROLE_PERMISSIONS,
  ROLES,
} from "@/modules/permissions/constants";
import {
  clinicalFieldDefinitions,
  clinicalOptionLists,
  clinicalSections,
  permissions,
  rolePermissions,
  roles,
  userRoles,
  users,
} from "./schema";
import { createDb, type Database } from "./client";

/**
 * Idempotent seed: safe to run repeatedly. Fully recomputes
 * role_permissions from the ROLE_PERMISSIONS constant each run so removing
 * a permission from a role in code also removes it in the database.
 */
export interface AdminBootstrap {
  email: string;
  password: string;
}

/**
 * Creates the initial administrator ONLY if no user with that email exists.
 * An existing account is never modified: its password, active state and
 * roles are left exactly as they are, so re-running the seed cannot restore
 * a bootstrap credential or re-enable a deliberately disabled admin.
 * User + ADMIN role are inserted in one transaction so a partial bootstrap
 * cannot leave a role-less account that later runs would then skip.
 *
 * Returns "created" or "exists".
 */
export async function bootstrapAdmin(
  db: Database,
  admin: AdminBootstrap,
): Promise<"created" | "exists"> {
  const email = admin.email.trim().toLowerCase();

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (existing) return "exists";

  const passwordHash = await hashPassword(admin.password);

  return db.transaction(async (tx) => {
    const [adminRole] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.code, ROLES.ADMIN))
      .limit(1);
    if (!adminRole) throw new Error("ADMIN role missing — seed roles first.");

    // ON CONFLICT DO NOTHING on the unique lower(email) index covers a
    // concurrent bootstrap: the loser changes nothing.
    const [created] = await tx
      .insert(users)
      .values({ email, displayName: "Administrator", passwordHash, isActive: true })
      .onConflictDoNothing()
      .returning({ id: users.id });
    if (!created) return "exists";

    await tx.insert(userRoles).values({ userId: created.id, roleId: adminRole.id });
    return "created";
  });
}

export async function seedClinicalDefinitions(db: Database): Promise<void> {
  for (const section of CLINICAL_SECTIONS) {
    const [sectionRow] = await db
      .insert(clinicalSections)
      .values({ code: section.code, name: section.name, sortOrder: section.sortOrder })
      .onConflictDoUpdate({
        target: clinicalSections.code,
        set: { name: section.name, sortOrder: section.sortOrder },
      })
      .returning();
    if (!sectionRow) throw new Error(`Failed to seed clinical section ${section.code}`);

    for (const [index, field] of section.fields.entries()) {
      let optionListId: string | null = null;
      if (isSelectType(field.type)) {
        const [list] = await db
          .insert(clinicalOptionLists)
          .values({ code: optionListCode(section.code, field.code), name: field.label })
          .onConflictDoUpdate({
            target: clinicalOptionLists.code,
            set: { name: field.label },
          })
          .returning();
        if (!list) throw new Error(`Failed to seed option list for ${field.code}`);
        optionListId = list.id;
      }

      await db
        .insert(clinicalFieldDefinitions)
        .values({
          sectionId: sectionRow.id,
          code: field.code,
          label: field.label,
          fieldType: field.type,
          optionListId,
          allowsFreeText: true,
          sortOrder: index + 1,
        })
        .onConflictDoUpdate({
          target: [clinicalFieldDefinitions.sectionId, clinicalFieldDefinitions.code],
          set: {
            label: field.label,
            fieldType: field.type,
            optionListId,
            sortOrder: index + 1,
          },
        });
    }
  }
}

export async function seed(
  connectionString: string,
  options: { admin?: AdminBootstrap } = {},
): Promise<void> {
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

    // 3b. Clinical sections/fields/option lists (structure only, no option
    // values). Never deletes; existing option rows are untouched.
    await seedClinicalDefinitions(db);

    // 4. Initial admin user: explicit option, else both env vars.
    const env = getEnv();
    const admin =
      options.admin ??
      (env.SEED_ADMIN_EMAIL && env.SEED_ADMIN_PASSWORD
        ? { email: env.SEED_ADMIN_EMAIL, password: env.SEED_ADMIN_PASSWORD }
        : undefined);
    if (admin) {
      const outcome = await bootstrapAdmin(db, admin);
      console.log(
        outcome === "created"
          ? `Created initial admin user: ${admin.email.trim().toLowerCase()}`
          : "Admin user already exists — left unchanged (password, active state, roles).",
      );
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
