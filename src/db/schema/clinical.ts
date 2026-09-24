import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
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

export const clinicalFieldDefinitions = pgTable(
  "clinical_field_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sectionId: uuid("section_id")
      .notNull()
      .references(() => clinicalSections.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    label: text("label").notNull(),
    // 'select' | 'multiselect' | 'text' | 'textarea'
    fieldType: text("field_type").notNull(),
    optionListId: uuid("option_list_id").references(
      () => clinicalOptionLists.id,
      { onDelete: "restrict" },
    ),
    allowsFreeText: boolean("allows_free_text").notNull().default(true),
    sortOrder: integer("sort_order").notNull(),
    isActive: boolean("is_active").notNull().default(true),
  },
  (table) => [
    uniqueIndex("clinical_field_definitions_section_code_idx").on(
      table.sectionId,
      table.code,
    ),
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
    index("clinical_entries_visit_id_idx").on(table.visitId),
  ],
);
