import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { roles, userRoles, users } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { writeAudit } from "@/modules/audit/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { requirePermission } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import type { CreateUserInput, SetUserActiveInput } from "./schema";

export class DuplicateEmailError extends Error {
  constructor() {
    super("A user with this email already exists.");
    this.name = "DuplicateEmailError";
  }
}

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  roleCodes: string[];
  createdAt: Date;
}

/** Never selects password_hash. */
export async function listUsers(
  db: Database,
  actor: ActorContext,
): Promise<UserSummary[]> {
  await requirePermissionStandalone(db, actor, PERMISSIONS.USER_READ);

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      isActive: users.isActive,
      createdAt: users.createdAt,
      roleCode: roles.code,
    })
    .from(users)
    .leftJoin(userRoles, eq(userRoles.userId, users.id))
    .leftJoin(roles, eq(roles.id, userRoles.roleId))
    .orderBy(users.createdAt);

  const byId = new Map<string, UserSummary>();
  for (const row of rows) {
    let entry = byId.get(row.id);
    if (!entry) {
      entry = {
        id: row.id,
        email: row.email,
        displayName: row.displayName,
        isActive: row.isActive,
        roleCodes: [],
        createdAt: row.createdAt,
      };
      byId.set(row.id, entry);
    }
    if (row.roleCode) entry.roleCodes.push(row.roleCode);
  }
  return Array.from(byId.values());
}

export async function createUser(
  db: Database,
  actor: ActorContext,
  input: CreateUserInput,
): Promise<UserSummary> {
  await requirePermission(db, actor, PERMISSIONS.USER_MANAGE, {
    entityType: "user",
  });

  return db.transaction(async (tx) => {
    const email = input.email.trim().toLowerCase();

    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);
    if (existing) {
      throw new DuplicateEmailError();
    }

    const passwordHash = await hashPassword(input.password);

    const [created] = await tx
      .insert(users)
      .values({
        email,
        displayName: input.displayName.trim(),
        passwordHash,
        isActive: true,
      })
      .returning();
    if (!created) throw new Error("Failed to create user");

    const matchedRoles = await tx
      .select()
      .from(roles)
      .where(inArray(roles.code, input.roleCodes));

    if (matchedRoles.length !== input.roleCodes.length) {
      throw new Error("One or more roles do not exist. Run the seed script.");
    }

    await tx.insert(userRoles).values(
      matchedRoles.map((r) => ({ userId: created.id, roleId: r.id })),
    );

    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "user.create",
      entityType: "user",
      entityId: created.id,
      after: {
        email: created.email,
        displayName: created.displayName,
        isActive: created.isActive,
        roleCodes: input.roleCodes,
      },
      metadata: { ip: actor.ip ?? null, userAgent: actor.userAgent ?? null },
    });

    return {
      id: created.id,
      email: created.email,
      displayName: created.displayName,
      isActive: created.isActive,
      roleCodes: input.roleCodes,
      createdAt: created.createdAt,
    };
  });
}

export async function setUserActive(
  db: Database,
  actor: ActorContext,
  input: SetUserActiveInput,
): Promise<void> {
  await requirePermission(db, actor, PERMISSIONS.USER_MANAGE, {
    entityType: "user",
    entityId: input.userId,
  });

  await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ id: users.id, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (!before) throw new Error("User not found");

    await tx
      .update(users)
      .set({ isActive: input.isActive, updatedAt: new Date() })
      .where(eq(users.id, input.userId));

    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "user.update",
      entityType: "user",
      entityId: input.userId,
      before: { isActive: before.isActive },
      after: { isActive: input.isActive },
      metadata: { ip: actor.ip ?? null, userAgent: actor.userAgent ?? null },
    });
  });
}

/** Permission guard for user-admin reads; denials are audited by requirePermission. */
async function requirePermissionStandalone(
  db: Database,
  actor: ActorContext,
  code: Parameters<typeof requirePermission>[2],
): Promise<void> {
  await requirePermission(db, actor, code, { entityType: "user" });
}
