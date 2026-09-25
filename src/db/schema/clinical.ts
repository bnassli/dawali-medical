import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import { patients } from "./patients";
import { visits } from "./visits";

/**
 * Value stored in a clinical entry. `optionIds` reference clinical_options;
 * `freeText` is visit-only text that is never added to any option list.
 */
export interface ClinicalEntryValue {
  optionIds: string[];
  freeText: string;
  /**
   * Only for `checkbox` fields (ADR-027): always present (true/false) on
   * their rows, never present on any other field's rows. Absent = unchecked.
   */
  checked?: boolean;
}

export const clinicalSections = pgTable("clinical_sections", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull(),
});

export const clinicalOptionLists = pgTable("clinical_option_lists", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
});

/**
 * Configurable dropdown options (CLAUDE.md rule #10). Options are never
 * renamed or deleted: retiring sets is_active = false so historical entries
 * that reference an option keep resolving.
 */
export const clinicalOptions = pgTable(
  "clinical_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listId: uuid("list_id")
      .notNull()
      .references(() => clinicalOptionLists.id, { onDelete: "restrict" }),
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
    uniqueIndex("clinical_options_list_id_lower_label_idx").on(
      table.listId,
      sql`lower(${table.label})`,
    ),
  ],
);

/**
 * GLOBAL field definitions (ADR-026). A concept such as Current Meds or
 * Allergies is defined exactly once here (globally unique `code`), so its
 * entries have a single source of truth however many tabs show it. Which tab
 * shows it, and in what order, lives in clinical_section_fields. Several
 * fields may point at the same option list (reusable lists).
 *
 * Structural columns (field_type, option_list_id, allows_free_text) are never
 * changed by the seed: changing them requires a migration, because clinical
 * entries may already exist.
 */
export const clinicalFieldDefinitions = pgTable("clinical_field_definitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  label: text("label").notNull(),
  // 'select' | 'multiselect' | 'text' | 'textarea'
  fieldType: text("field_type").notNull(),
  optionListId: uuid("option_list_id").references(
    () => clinicalOptionLists.id,
    { onDelete: "restrict" },
  ),
  allowsFreeText: boolean("allows_free_text").notNull().default(true),
  isActive: boolean("is_active").notNull().default(true),
});

/**
 * Placement of a global field inside a section (tab): order only, no data.
 * The same field may be placed in several sections; entries stay keyed by
 * (visit, field), so repeated UI sections never create a second source.
 */
export const clinicalSectionFields = pgTable(
  "clinical_section_fields",
  {
    sectionId: uuid("section_id")
      .notNull()
      .references(() => clinicalSections.id, { onDelete: "restrict" }),
    fieldDefinitionId: uuid("field_definition_id")
      .notNull()
      .references(() => clinicalFieldDefinitions.id, { onDelete: "restrict" }),
    sortOrder: integer("sort_order").notNull(),
    // Presentation only: the tab's own label for this field (ADR-027), e.g.
    // "Family Medical Hx" for the shared family_history. NULL = the field's label.
    labelOverride: text("label_override"),
  },
  (table) => [
    primaryKey({ columns: [table.sectionId, table.fieldDefinitionId] }),
    index("clinical_section_fields_field_idx").on(table.fieldDefinitionId),
  ],
);

/**
 * Append-only version rows: every change to a field for a visit inserts a new
 * row with version + 1; the current value is the highest version. A DB
 * trigger (drizzle/0003_clinical_entries_append_only.sql) rejects
 * UPDATE/DELETE so history cannot be rewritten (ADR-008).
 */
export const clinicalEntries = pgTable(
  "clinical_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    visitId: uuid("visit_id")
      .notNull()
      .references(() => visits.id, { onDelete: "restrict" }),
    fieldDefinitionId: uuid("field_definition_id")
      .notNull()
      .references(() => clinicalFieldDefinitions.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    value: jsonb("value").$type<ClinicalEntryValue>().notNull(),
    // Client-generated idempotency key: a replayed mutation returns the
    // original result instead of creating another version. NULL for rows
    // that were not created by a client save (e.g. the legacy backfill).
    clientMutationId: uuid("client_mutation_id"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("clinical_entries_visit_field_version_idx").on(
      table.visitId,
      table.fieldDefinitionId,
      table.version,
    ),
    uniqueIndex("clinical_entries_client_mutation_id_idx")
      .on(table.clientMutationId)
      .where(sql`${table.clientMutationId} IS NOT NULL`),
    index("clinical_entries_visit_id_idx").on(table.visitId),
  ],
);

/**
 * Treatment Plan (R2, ADR-030): one plan per PATIENT, shared by every visit.
 * A row of the plan. Insert-only (trigger in drizzle/0008): its order and
 * owner never change; a wrong row is marked Cancelled, never deleted. The
 * client chooses the id of a new row; the first saved cell creates it.
 */
export const treatmentPlanItems = pgTable(
  "treatment_plan_items",
  {
    id: uuid("id").primaryKey(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    // Order the row was added in (1, 2, 3...), assigned under the patient row lock.
    position: integer("position").notNull(),
    createdInVisitId: uuid("created_in_visit_id")
      .notNull()
      .references(() => visits.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("treatment_plan_items_patient_position_idx").on(table.patientId, table.position)],
);

/**
 * Append-only versions of one cell of a plan row (same value shape and rules
 * as clinical_entries). `visit_id` is the visit the change was made from.
 * UPDATE/DELETE are rejected by a trigger (drizzle/0008).
 */
export const treatmentPlanEntries = pgTable(
  "treatment_plan_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => treatmentPlanItems.id, { onDelete: "restrict" }),
    fieldDefinitionId: uuid("field_definition_id")
      .notNull()
      .references(() => clinicalFieldDefinitions.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    value: jsonb("value").$type<ClinicalEntryValue>().notNull(),
    visitId: uuid("visit_id")
      .notNull()
      .references(() => visits.id, { onDelete: "restrict" }),
    clientMutationId: uuid("client_mutation_id").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("treatment_plan_entries_item_field_version_idx").on(
      table.itemId,
      table.fieldDefinitionId,
      table.version,
    ),
    uniqueIndex("treatment_plan_entries_client_mutation_id_idx").on(table.clientMutationId),
    index("treatment_plan_entries_item_id_idx").on(table.itemId),
  ],
);
