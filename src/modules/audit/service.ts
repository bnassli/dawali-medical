import { auditLogs } from "@/db/schema";
import type { Database } from "@/db/client";

/**
 * A transaction-capable handle: either the top-level Database or a
 * transaction object passed to db.transaction(async (tx) => ...). Drizzle's
 * tx type is structurally compatible with Database for our purposes (both
 * expose .insert/.select/etc).
 */
export type Tx = Database;

export interface AuditMetadata {
  ip?: string | null;
  userAgent?: string | null;
  reason?: string | null;
  [key: string]: unknown;
}

export interface AuditEntry {
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  patientId?: string | null;
  visitId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: AuditMetadata | null;
}

/**
 * Writes a single append-only audit row. MUST be called inside the same
 * transaction as the change it describes, so that the audit trail and the
 * data mutation succeed or fail atomically (CLAUDE.md rule #8).
 */
export async function writeAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLogs).values({
    actorUserId: entry.actorUserId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    patientId: entry.patientId ?? null,
    visitId: entry.visitId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    metadata: entry.metadata ?? null,
  });
}
