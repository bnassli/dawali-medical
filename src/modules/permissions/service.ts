import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { patients, visits } from "@/db/schema";
import { writeAudit } from "@/modules/audit/service";
import type { PermissionCode } from "./constants";
import { ForbiddenError } from "./errors";
import type { ActorContext } from "./types";

export { ForbiddenError } from "./errors";
export type { ActorContext } from "./types";

export interface DenialContext {
  entityType?: string;
  entityId?: string;
  patientId?: string | null;
  visitId?: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ATTEMPTED_LENGTH = 200;

function clip(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.length > MAX_ATTEMPTED_LENGTH ? `${value.slice(0, MAX_ATTEMPTED_LENGTH)}…` : value;
}

/**
 * Writes an `access.denied` audit row. The ids in `context` come from
 * untrusted input (URLs, request bodies) and audit_logs.patient_id/visit_id
 * are foreign keys, so they are resolved first: an id is stored in the FK
 * column only if that row exists; otherwise the row is still written (FK
 * columns null) and the attempted ids are recorded, clipped, in
 * metadata.attempted. A nonexistent or malformed id can therefore never make
 * the denial fail with an FK error (which would surface as a 500).
 *
 * MUST be called with the top-level Database handle, never inside the guarded
 * transaction (a rollback would erase the denial).
 */
export async function auditAccessDenied(
  db: Database,
  actor: ActorContext,
  context: DenialContext,
  extraMetadata: Record<string, unknown> = {},
): Promise<void> {
  let visitId: string | null = null;
  let patientId: string | null = null;

  if (context.visitId && UUID_PATTERN.test(context.visitId)) {
    const [visit] = await db
      .select({ id: visits.id, patientId: visits.patientId })
      .from(visits)
      .where(eq(visits.id, context.visitId))
      .limit(1);
    if (visit) {
      visitId = visit.id;
      patientId = visit.patientId;
    }
  }
  if (!patientId && context.patientId && UUID_PATTERN.test(context.patientId)) {
    const [patient] = await db
      .select({ id: patients.id })
      .from(patients)
      .where(eq(patients.id, context.patientId))
      .limit(1);
    if (patient) patientId = patient.id;
  }

  await writeAudit(db, {
    actorUserId: actor.userId,
    action: "access.denied",
    entityType: context.entityType ?? "permission",
    entityId: clip(context.entityId) ?? "unknown",
    patientId,
    visitId,
    metadata: {
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      attempted: {
        entityId: clip(context.entityId),
        patientId: clip(context.patientId),
        visitId: clip(context.visitId),
      },
      ...extraMetadata,
    },
  });
}

/**
 * Throws a ForbiddenError if the actor lacks `code`. On denial, writes an
 * `access.denied` audit row (CLAUDE.md rule #8; PROMPT_SPRINT_1
 * permission-denial requirement) via auditAccessDenied, which is safe for
 * untrusted ids.
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
  context?: DenialContext,
): Promise<void> {
  if (actor.permissions.has(code)) {
    return;
  }

  await auditAccessDenied(
    db,
    actor,
    { ...context, entityId: context?.entityId ?? code },
    { requiredPermission: code },
  );

  throw new ForbiddenError(code);
}

export function hasPermission(
  actor: ActorContext,
  code: PermissionCode,
): boolean {
  return actor.permissions.has(code);
}
