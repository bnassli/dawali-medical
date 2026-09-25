import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./core";
import { patients } from "./patients";
import { visits } from "./visits";

/**
 * A stored patient file (ADR-033). The bytes live in private file storage
 * (never in PostgreSQL, never public); this row is the metadata and the only
 * way to reach them. Insert-only (trigger): a file is never replaced.
 */
export const patientFiles = pgTable(
  "patient_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    visitId: uuid("visit_id").references(() => visits.id, { onDelete: "restrict" }),
    // 'diagram' now; 'report' in R5.
    kind: text("kind").notNull(),
    storageKey: text("storage_key").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("patient_files_storage_key_idx").on(table.storageKey),
    index("patient_files_patient_idx").on(table.patientId),
  ],
);

/** A Leg or Vein diagram of one visit (R4). Insert-only; its drawings are versions. */
export const diagrams = pgTable(
  "diagrams",
  {
    id: uuid("id").primaryKey(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    visitId: uuid("visit_id")
      .notNull()
      .references(() => visits.id, { onDelete: "restrict" }),
    // 'leg' | 'vein' (DIAGRAM_TYPES); also names the immutable base template.
    diagramType: text("diagram_type").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("diagrams_visit_idx").on(table.visitId)],
);

export interface DiagramStroke {
  color: string;
  width: number;
  erase: boolean;
  /** Points in template coordinates, flattened [x0, y0, x1, y1, ...]. */
  points: number[];
}

/**
 * Append-only saved versions of a diagram (trigger): v1, v2, ... Each keeps the
 * editable drawing (`strokes`, over the base template) and the rendered PNG
 * (a patient file) for reports. Saving never overwrites an earlier version.
 */
export const diagramVersions = pgTable(
  "diagram_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    diagramId: uuid("diagram_id")
      .notNull()
      .references(() => diagrams.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    strokes: jsonb("strokes").$type<DiagramStroke[]>().notNull(),
    pngFileId: uuid("png_file_id")
      .notNull()
      .references(() => patientFiles.id, { onDelete: "restrict" }),
    clientMutationId: uuid("client_mutation_id").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("diagram_versions_diagram_version_idx").on(table.diagramId, table.version),
    uniqueIndex("diagram_versions_client_mutation_id_idx").on(table.clientMutationId),
  ],
);
