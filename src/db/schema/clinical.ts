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
  /**
   * Only for `ordered_list` fields (ADR-029): the visible rows in order, each an
   * option of the field's list and/or free text. Trailing empty rows are not
   * stored; absent = no rows. `optionIds`/`freeText` are always empty on them.
   */
  rows?: ClinicalOrderedRow[];
  /**
   * Only for `ordered_list` fields with a display mode (Impression, ADR-029).
   * Stored only when "numbers"; absent = "bullets" (the default).
   */
  display?: "numbers";
  /** Only for `number` fields (ADR-029): the value in the field's unit. Absent = empty. */
  numberValue?: number;
}

export interface ClinicalOrderedRow {
  optionId: string | null;
  freeText: string;
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
  // 'select' | 'multiselect' | 'text' | 'textarea' | 'checkbox' | 'ordered_list' | 'number'
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
    // Presentation only: visual group heading of this placement (ADR-029), e.g.
    // "Habits". Consecutive fields with the same group render as one block.
    groupLabel: text("group_label"),
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
