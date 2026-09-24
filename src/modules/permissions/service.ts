import type { Tx } from "@/modules/audit/service";
import { writeAudit } from "@/modules/audit/service";
import type { PermissionCode } from "./constants";
import { ForbiddenError } from "./errors";
import type { ActorContext } from "./types";

export { ForbiddenError } from "./errors";
export type { ActorContext } from "./types";

/**
 * Throws a ForbiddenError if the actor lacks `code`. On denial, writes an
 * `access.denied` audit row inside the same transaction (CLAUDE.md rule #8;
 * PROMPT_SPRINT_1 permission-denial requirement).
 *
 * Callers must run this inside a db.transaction() so the audit write is
 * durable even though the guarded action never proceeds.
 */
export async function requirePermission(
  tx: Tx,
  actor: ActorContext,
  code: PermissionCode,
  context?: { entityType?: string; entityId?: string; patientId?: string | null },
): Promise<void> {
  if (actor.permissions.has(code)) {
    return;
  }

  await writeAudit(tx, {
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
