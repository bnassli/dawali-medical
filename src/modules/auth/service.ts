import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { permissions, rolePermissions, sessions, userRoles, users } from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/password";
import { getEnv } from "@/lib/env";
import { generateSessionToken, hashSessionToken } from "@/lib/session-token";
import { writeAudit } from "@/modules/audit/service";
import type { PermissionCode } from "@/modules/permissions/constants";
import type { ActorContext } from "@/modules/permissions/types";
import { AuthenticationError } from "./errors";
import type { LoginInput } from "./schema";

export { AuthenticationError } from "./errors";

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface LoginResult {
  token: string;
  expiresAt: Date;
  userId: string;
  displayName: string;
}

/**
 * Loads the full permission set for a user by joining
 * user_roles -> role_permissions -> permissions. Used both after login and
 * on every session validation so permission changes take effect immediately
 * without requiring re-login.
 */
export async function loadActorContext(
  db: Database,
  userId: string,
  meta: RequestMeta = {},
): Promise<ActorContext | null> {
  const [user] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user || !user.isActive) {
    return null;
  }

  const rows = await db
    .select({ code: permissions.code })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(eq(userRoles.userId, userId));

  const permissionSet = new Set<PermissionCode>(
    rows.map((r) => r.code as PermissionCode),
  );

  return {
    userId: user.id,
    displayName: user.displayName,
    permissions: permissionSet,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  };
}

/**
 * Authenticates a user and creates a new DB-backed session. Always returns
 * the same generic AuthenticationError on any failure (unknown email,
 * inactive user, wrong password) and audits `auth.login_failed` without
 * ever logging the submitted password. On success, audits `auth.login`.
 */
export async function login(
  db: Database,
  input: LoginInput,
  meta: RequestMeta = {},
): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase();

  return db.transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);

    const passwordOk = user
      ? await verifyPassword(user.passwordHash, input.password)
      : await failClosedHash(input.password); // constant-time-ish decoy

    if (!user || !user.isActive || !passwordOk) {
      await writeAudit(tx, {
        actorUserId: user?.id ?? null,
        action: "auth.login_failed",
        entityType: "user",
        entityId: user?.id ?? email,
        metadata: {
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          emailAttempted: email,
        },
      });
      throw new AuthenticationError();
    }

    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const ttlHours = getEnv().SESSION_TTL_HOURS;
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    await tx.insert(sessions).values({
      userId: user.id,
      tokenHash,
      expiresAt,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });

    await writeAudit(tx, {
      actorUserId: user.id,
      action: "auth.login",
      entityType: "user",
      entityId: user.id,
      metadata: { ip: meta.ip ?? null, userAgent: meta.userAgent ?? null },
    });

    return {
      token,
      expiresAt,
      userId: user.id,
      displayName: user.displayName,
    };
  });
}

/**
 * Runs a dummy argon2 verification so that the login() code path takes
 * roughly the same amount of time whether or not the email exists,
 * reducing (not eliminating) user-enumeration via timing.
 */
async function failClosedHash(password: string): Promise<boolean> {
  const dummyHash = await hashPassword("dummy-password-for-timing-parity");
  return verifyPassword(dummyHash, password);
}

/**
 * Validates a raw session token from the cookie. Rejects missing, expired,
 * and revoked tokens, and tokens belonging to now-inactive users.
 */
export async function validateSession(
  db: Database,
  token: string | undefined | null,
  meta: RequestMeta = {},
): Promise<ActorContext | null> {
  if (!token) return null;

  const tokenHash = hashSessionToken(token);
  const now = new Date();

  const [session] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
      ),
    )
    .limit(1);

  if (!session) return null;

  return loadActorContext(db, session.userId, meta);
}

/**
 * Revokes the session identified by the raw token (idempotent) and audits
 * `auth.logout`. Never throws if the token is already invalid/unknown.
 */
export async function logout(
  db: Database,
  token: string | undefined | null,
  meta: RequestMeta = {},
): Promise<void> {
  if (!token) return;
  const tokenHash = hashSessionToken(token);

  await db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
      .limit(1);

    if (!session) return;

    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.id, session.id));

    await writeAudit(tx, {
      actorUserId: session.userId,
      action: "auth.logout",
      entityType: "user",
      entityId: session.userId,
      metadata: { ip: meta.ip ?? null, userAgent: meta.userAgent ?? null },
    });
  });
}
