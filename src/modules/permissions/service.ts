import type { Database } from "@/db/client";
import { writeAudit } from "@/modules/audit/service";
import type { PermissionCode } from "./constants";
import { ForbiddenError } from "./errors";
import type { ActorContext } from "./types";

export { ForbiddenError } from "./errors";
export type { ActorContext } from "./types";

/**
 * Throws a ForbiddenError if the actor lacks `code`. On denial, writes an
 * `access.denied` audit row (CLAUDE.md rule #8; PROMPT_SPRINT_1
 * permission-denial requirement).
 *
 * MUST be called with the top-level Database handle, BEFORE opening the
 * transaction for the guarded action — never with a transaction handle.
 * The denial audit row is committed on its own; if it were written inside
 * the guarded transaction, the ForbiddenError thrown here would roll it back
 * and the denial would silently disappear from the audit trail.
 */
export async function requirePermission(
  db: Database,
  actor: ActorContext,
  code: PermissionCode,
  context?: { entityType?: string; entityId?: string; patientId?: string | null },
): Promise<void> {
  if (actor.permissions.has(code)) {
    return;
  }

  await writeAudit(db, {
    actorUserId: actor.userId,
    action: "access.denied",
    entityType: context?.entityType ?? "permission",
    entityId: context?.entityId ?? code,
    patientId: context?.patientId ?? null,
    metadata: {
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      requiredPermission: code,
    },
  });

  throw new ForbiddenError(code);
}

export function hasPermission(
  actor: ActorContext,
  code: PermissionCode,
): boolean {
  return actor.permissions.has(code);
}
