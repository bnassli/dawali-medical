import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { users } from "./core";

/**
 * Configurable DEMOGRAPHIC option lists (ADR-028): Nationality and Preferred
 * Language. Deliberately separate from clinical_options: they are patient
 * registration data (Reception adds them), not clinical dropdowns, and must not
 * appear in or be governed by the clinical option permissions. The list codes are
 * structural (CHECK constraint); the VALUES are data, added with "+ Add New".
 * Options are never renamed or deleted: retiring sets is_active = false so a
 * patient that references a retired option keeps showing it.
 */
export const demographicOptions = pgTable(
  "demographic_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listCode: text("list_code").notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("demographic_options_list_lower_label_idx").on(
      table.listCode,
      sql`lower(${table.label})`,
    ),
    check(
      "demographic_options_list_code_check",
      sql`${table.listCode} IN ('nationality', 'preferred_language')`,
    ),
  ],
);

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
    // 'F' | 'M' | NULL (unknown/blank). Normalised by migration 0006 (ADR-028):
    // a demographic code the Female-specific clinical rule depends on, not a
    // clinical dropdown.
    sex: text("sex"),
    // Mobile / cell phone.
    phone: text("phone"),
    email: text("email"),
    nationalityOptionId: uuid("nationality_option_id").references(
      (): AnyPgColumn => demographicOptions.id,
      { onDelete: "restrict" },
    ),
    preferredLanguageOptionId: uuid("preferred_language_option_id").references(
      (): AnyPgColumn => demographicOptions.id,
      { onDelete: "restrict" },
    ),
    // NOT unique: several patients (e.g. a family) may share one (ADR-028).
    insuranceId: text("insurance_id"),
    // Inactive patients are hidden from default search and cannot get new
    // visits; only Admin may change this (patient.set_active).
    isActive: boolean("is_active").notNull().default(true),
    emergencyContactName: text("emergency_contact_name"),
    emergencyContactPhone: text("emergency_contact_phone"),
    emergencyContactRelationship: text("emergency_contact_relationship"),
    // Optimistic concurrency for demographic edits: every update must supply
    // the version it was based on and bumps it by one.
    version: integer("version").notNull().default(1),
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
    index("patients_insurance_id_lower_idx").on(sql`lower(${table.insuranceId})`),
    check("patients_sex_check", sql`${table.sex} IN ('F', 'M')`),
  ],
);

/**
 * External identifiers for a patient in a foreign system, e.g.
 * { system: 'ICARE_FILE_NO', value: '12345' } — the File / Medical ID shown to
 * users — or { system: 'NATIONAL_ID', ... } (National ID / Iqama). A patient
 * has at most one value per system (enforced by the service). Never used as a
 * primary key anywhere in this application.
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
