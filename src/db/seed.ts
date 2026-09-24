import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { getEnv } from "@/lib/env";
import { hashPassword } from "@/lib/password";
import {
  assertDefinitionsConsistent,
  assertFieldConfigConsistent,
  DEFAULT_CLINICAL_DEFINITIONS,
  optionListCodeFor,
  type ClinicalDefinitions,
} from "@/modules/clinical/definitions";
import {
  ALL_PERMISSION_CODES,
  PERMISSION_DESCRIPTIONS,
  ROLE_NAMES,
  ROLE_PERMISSIONS,
  ROLES,
} from "@/modules/permissions/constants";
import {
  DEFAULT_DEMOGRAPHIC_OPTIONS,
  DEMOGRAPHIC_LIST_CODES,
} from "@/modules/patients/constants";
import {
  clinicalFieldDefinitions,
  clinicalOptionLists,
  clinicalSectionFields,
  clinicalSections,
  demographicOptions,
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

/**
 * Thrown when the seed finds an existing global field whose structure
 * (type / option list / free-text flag) differs from the definitions. Clinical
 * entries may already exist for it, so the seed refuses to alter it silently:
 * write a migration instead (ADR-026).
 */
export class StructuralDefinitionChangeError extends Error {
  constructor(fieldCode: string, differences: string[]) {
    super(
      `Clinical field "${fieldCode}" already exists with a different structure (${differences.join("; ")}). ` +
        "Changing a field's type, option list or free-text flag requires a migration; the seed will not do it silently.",
    );
    this.name = "StructuralDefinitionChangeError";
  }
}

/**
 * Idempotent, non-destructive seed of sections, GLOBAL fields, option lists
 * and section placements (ADR-026). Existing rows are only ever updated in
 * cosmetic ways (labels, names, placement order, groups) or retired (one-way,
 * ADR-029); structural differences abort
 * the seed before anything is changed. Nothing is deleted; option rows are
 * never touched.
 */
export async function seedClinicalDefinitions(
  db: Database,
  definitions: ClinicalDefinitions = DEFAULT_CLINICAL_DEFINITIONS,
): Promise<void> {
  assertDefinitionsConsistent(definitions);
  assertFieldConfigConsistent(definitions, { complete: false });

  await db.transaction(async (tx) => {
    // 1. Option lists (reusable: several fields may share one).
    const listIdByCode = new Map<string, string>();
    for (const field of definitions.fields) {
      const listCode = optionListCodeFor(field);
      if (!listCode || listIdByCode.has(listCode)) continue;
      const [list] = await tx
        .insert(clinicalOptionLists)
        .values({ code: listCode, name: field.label })
        .onConflictDoNothing()
        .returning();
      if (list) {
        listIdByCode.set(listCode, list.id);
        continue;
      }
      const [existing] = await tx
        .select()
        .from(clinicalOptionLists)
        .where(eq(clinicalOptionLists.code, listCode))
        .limit(1);
      if (!existing) throw new Error(`Failed to seed option list ${listCode}`);
      listIdByCode.set(listCode, existing.id);
    }

    // 2. Global field definitions. Detect structural drift first.
    const existingFields = await tx.select().from(clinicalFieldDefinitions);
    const existingByCode = new Map(existingFields.map((f) => [f.code, f]));
    const listCodeById = new Map<string, string>();
    for (const [code, id] of listIdByCode) listCodeById.set(id, code);
    const allLists = await tx.select().from(clinicalOptionLists);
    for (const l of allLists) listCodeById.set(l.id, l.code);

    for (const field of definitions.fields) {
      const existing = existingByCode.get(field.code);
      if (!existing) continue;
      const differences: string[] = [];
      if (existing.fieldType !== field.type) {
        differences.push(`type ${existing.fieldType} -> ${field.type}`);
      }
      const wantedList = optionListCodeFor(field);
      const currentList = existing.optionListId
        ? (listCodeById.get(existing.optionListId) ?? existing.optionListId)
        : null;
      if (currentList !== wantedList) {
        differences.push(`option list ${currentList ?? "none"} -> ${wantedList ?? "none"}`);
      }
      if (!existing.allowsFreeText) differences.push("free text allowed true <- false");
      if (differences.length > 0) throw new StructuralDefinitionChangeError(field.code, differences);
    }

    const fieldIdByCode = new Map<string, string>();
    for (const field of definitions.fields) {
      const listCode = optionListCodeFor(field);
      const [row] = await tx
        .insert(clinicalFieldDefinitions)
        .values({
          code: field.code,
          label: field.label,
          fieldType: field.type,
          optionListId: listCode ? (listIdByCode.get(listCode) ?? null) : null,
          allowsFreeText: true,
          isActive: !field.retired,
        })
        .onConflictDoUpdate({
          target: clinicalFieldDefinitions.code,
          // Cosmetic only; structure was verified identical above. Retirement is
          // one-way (ADR-029): a retired field is deactivated, never reactivated,
          // and its entries stay untouched (read-only history).
          set: field.retired ? { label: field.label, isActive: false } : { label: field.label },
        })
        .returning();
      if (!row) throw new Error(`Failed to seed clinical field ${field.code}`);
      fieldIdByCode.set(field.code, row.id);
    }

    // 3. Sections and placements.
    for (const section of definitions.sections) {
      const [sectionRow] = await tx
        .insert(clinicalSections)
        .values({ code: section.code, name: section.name, sortOrder: section.sortOrder })
        .onConflictDoUpdate({
          target: clinicalSections.code,
          set: { name: section.name, sortOrder: section.sortOrder },
        })
        .returning();
      if (!sectionRow) throw new Error(`Failed to seed clinical section ${section.code}`);

      for (const [index, code] of section.fieldCodes.entries()) {
        const fieldId = fieldIdByCode.get(code);
        if (!fieldId) throw new Error(`Unknown field ${code} in section ${section.code}`);
        const labelOverride = section.labelOverrides?.[code] ?? null;
        const groupLabel = section.groups?.[code] ?? null;
        await tx
          .insert(clinicalSectionFields)
          .values({
            sectionId: sectionRow.id,
            fieldDefinitionId: fieldId,
            sortOrder: index + 1,
            labelOverride,
            groupLabel,
          })
          .onConflictDoUpdate({
            target: [clinicalSectionFields.sectionId, clinicalSectionFields.fieldDefinitionId],
            set: { sortOrder: index + 1, labelOverride, groupLabel },
          });
      }
    }
  });
}

/**
 * Inserts the Product Owner's initial demographic options (ADR-028) when they do
 * not exist yet (case-insensitive). Never updates, reactivates or deletes: an
 * option an administrator retired stays retired across seed runs.
 */
export async function seedDemographicOptions(db: Database): Promise<void> {
  for (const listCode of DEMOGRAPHIC_LIST_CODES) {
    for (const [index, label] of DEFAULT_DEMOGRAPHIC_OPTIONS[listCode].entries()) {
      await db
        .insert(demographicOptions)
        .values({ listCode, label, sortOrder: index + 1 })
        .onConflictDoNothing();
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

    // 3b. Clinical sections/global fields/placements/option lists (structure
    // only, no option values). Never deletes; refuses structural changes.
    await seedClinicalDefinitions(db);

    // 3c. Initial demographic options (Preferred Language: Arabic, English).
    await seedDemographicOptions(db);

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
