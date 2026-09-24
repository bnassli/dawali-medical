import {
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import { patients } from "./patients";
import { visits } from "./visits";

/**
 * Append-only audit log. A DB trigger (see drizzle/0001_audit_append_only.sql)
 * rejects UPDATE/DELETE at the database level regardless of application code
 * path, so this table can never be silently altered (CLAUDE.md rule #8).
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    patientId: uuid("patient_id").references(() => patients.id, {
      onDelete: "set null",
    }),
    visitId: uuid("visit_id").references(() => visits.id, {
      onDelete: "set null",
    }),
    before: jsonb("before"),
    after: jsonb("after"),
    metadata: jsonb("metadata"),
  },
  (table) => [
    index("audit_logs_entity_idx").on(table.entityType, table.entityId),
    index("audit_logs_patient_id_idx").on(table.patientId),
    index("audit_logs_visit_id_idx").on(table.visitId),
    index("audit_logs_occurred_at_idx").on(table.occurredAt),
  ],
);
