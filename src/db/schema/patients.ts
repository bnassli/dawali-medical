import { sql } from "drizzle-orm";
import {
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./core";

/**
 * Patient — internal UUID primary key. External identifiers such as the
 * iCare file number are NEVER used as the primary key; see
 * patient_external_ids below. See CLAUDE.md rule #7 / ADR-001.
 */
export const patients = pgTable(
  "patients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    middleName: text("middle_name"),
    dateOfBirth: date("date_of_birth"),
    // Free text on purpose: not a hard-coded clinical dropdown (CLAUDE.md #10).
    sex: text("sex"),
    phone: text("phone"),
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    index("patients_last_name_lower_idx").on(sql`lower(${table.lastName})`),
    index("patients_first_name_lower_idx").on(sql`lower(${table.firstName})`),
    index("patients_phone_idx").on(table.phone),
  ],
);

/**
 * External identifiers for a patient in a foreign system, e.g.
 * { system: 'ICARE_FILE_NO', value: '12345' }. A patient may have zero or
 * more of these. Never used as a primary key anywhere in this application.
 */
export const patientExternalIds = pgTable(
  "patient_external_ids",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    system: text("system").notNull(),
    value: text("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("patient_external_ids_system_value_idx").on(
      table.system,
      table.value,
    ),
    index("patient_external_ids_value_idx").on(table.value),
    index("patient_external_ids_patient_id_idx").on(table.patientId),
  ],
);
