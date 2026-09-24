import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./core";
import { patients } from "./patients";

/**
 * A Visit is a distinct domain entity from Patient (CLAUDE.md rule #6).
 * Historical visits are never overwritten/deleted by this module.
 */
export const visits = pgTable(
  "visits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    idempotencyKey: uuid("idempotency_key").notNull().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    visitDate: timestamp("visit_date", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reason: text("reason"),
    status: text("status").notNull().default("open"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("visits_idempotency_key_idx").on(table.idempotencyKey),
    check(
      "visits_status_check",
      sql`${table.status} in ('open', 'closed', 'cancelled')`,
    ),
    index("visits_patient_id_visit_date_idx").on(
      table.patientId,
      table.visitDate,
    ),
  ],
);
