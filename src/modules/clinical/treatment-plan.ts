import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  clinicalFieldDefinitions,
  clinicalOptions,
  patients,
  treatmentPlanEntries,
  treatmentPlanItems,
  visits,
  type ClinicalEntryValue,
} from "@/db/schema";
import { writeAudit } from "@/modules/audit/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { requirePermission } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import {
  TREATMENT_PLAN_COLUMN_CODES,
  TREATMENT_PLAN_MIN_EMPTY_ROWS,
  TREATMENT_PLAN_MIN_ROWS,
} from "./definitions";
import type { SaveClinicalEntryInput } from "./schema";
import {
  ClinicalConflictError,
  ClinicalFieldNotFoundError,
  EMPTY_VALUE,
  isTreatmentPlanColumn,
  isUniqueViolation,
  loadFieldOptions,
  MutationIdReuseError,
  normalizeValue,
  pgErrorField,
  valuesEqual,
  VisitNotFoundError,
  VisitNotOpenError,
  type ClinicalFieldView,
} from "./service";

/**
 * Treatment Plan (R2, ADR-030): ONE plan per patient, shared by all of the
 * patient's visits. Rows (treatment_plan_items) keep the order they were added
 * in and are never deleted (a wrong row is marked Cancelled). Every cell is
 * versioned append-only in treatment_plan_entries, with the same value shape,
 * validation, optimistic concurrency, idempotency and audit as clinical entries.
 *
 * For the screen, each cell is presented as a ClinicalFieldView ("virtual
 * field", id `${itemId}:${columnFieldId}`), so the SonoSoft form, autosave,
 * conflict handling and unsaved-navigation guard are the same code as the
 * other tabs.
 */

export class TreatmentPlanItemNotFoundError extends Error {
  constructor(itemId: string) {
    super(`Treatment plan row not found: ${itemId}`);
    this.name = "TreatmentPlanItemNotFoundError";
  }
}

const MUTATION_ID_INDEX = "treatment_plan_entries_client_mutation_id_idx";

export interface TreatmentPlanRowView {
  itemId: string;
  /** 1-based order of the row in the plan; null for an empty row not saved yet. */
  position: number | null;
}

export interface TreatmentPlanView {
  visit: { id: string; patientId: string; status: string };
  rows: TreatmentPlanRowView[];
  /** One virtual field per cell, row by row, columns in TREATMENT_PLAN_COLUMN_CODES order. */
  fields: ClinicalFieldView[];
}

type ColumnRow = typeof clinicalFieldDefinitions.$inferSelect;

/** Code of a cell's virtual field: the layout places `${column}__${rowNumber}`. */
export function treatmentCellCode(columnCode: string, rowNumber: number): string {
  return `${columnCode}__${rowNumber}`;
}

export function treatmentCellId(itemId: string, columnFieldId: string): string {
  return `${itemId}:${columnFieldId}`;
}

export function treatmentRowCount(savedRows: number): number {
  return Math.max(TREATMENT_PLAN_MIN_ROWS, savedRows + TREATMENT_PLAN_MIN_EMPTY_ROWS);
}

async function loadColumns(db: Database): Promise<ColumnRow[]> {
  const rows = await db
    .select()
    .from(clinicalFieldDefinitions)
    .where(inArray(clinicalFieldDefinitions.code, [...TREATMENT_PLAN_COLUMN_CODES]));
  const byCode = new Map(rows.map((r) => [r.code, r]));
  return TREATMENT_PLAN_COLUMN_CODES.flatMap((code) => {
    const row = byCode.get(code);
    return row ? [row] : [];
  });
}

/**
 * The patient's plan as seen from one of their visits: saved rows in order,
 * then empty rows (new random ids) up to SonoSoft's 25, at least 5 empty.
 */
export async function getTreatmentPlanForVisit(
  db: Database,
  actor: ActorContext,
  visitId: string,
  newId: () => string = randomUUID,
): Promise<TreatmentPlanView> {
  await requirePermission(db, actor, PERMISSIONS.CLINICAL_READ, {
    entityType: "treatment_plan_entry",
    entityId: visitId,
    visitId,
  });

  const [visit] = await db
    .select({ id: visits.id, patientId: visits.patientId, status: visits.status })
    .from(visits)
    .where(eq(visits.id, visitId))
    .limit(1);
  if (!visit) throw new VisitNotFoundError(visitId);

  const columns = await loadColumns(db);
  const items = await db
    .select()
    .from(treatmentPlanItems)
    .where(eq(treatmentPlanItems.patientId, visit.patientId))
    .orderBy(asc(treatmentPlanItems.position));

  const itemIds = items.map((i) => i.id);
  const current =
    itemIds.length === 0
      ? []
      : await db
          .selectDistinctOn([treatmentPlanEntries.itemId, treatmentPlanEntries.fieldDefinitionId])
          .from(treatmentPlanEntries)
          .where(inArray(treatmentPlanEntries.itemId, itemIds))
          .orderBy(
            treatmentPlanEntries.itemId,
            treatmentPlanEntries.fieldDefinitionId,
            desc(treatmentPlanEntries.version),
          );
  const entryByCell = new Map(current.map((e) => [treatmentCellId(e.itemId, e.fieldDefinitionId), e]));

  const listIds = columns.map((c) => c.optionListId).filter((v): v is string => v !== null);
  const optionRows =
    listIds.length === 0
      ? []
      : await db
          .select()
          .from(clinicalOptions)
          .where(inArray(clinicalOptions.listId, listIds))
          .orderBy(asc(clinicalOptions.sortOrder), asc(clinicalOptions.label));

  const rows: TreatmentPlanRowView[] = items.map((i) => ({ itemId: i.id, position: i.position }));
  const total = treatmentRowCount(items.length);
  while (rows.length < total) rows.push({ itemId: newId(), position: null });

  const fields: ClinicalFieldView[] = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    for (const column of columns) {
      const entry = entryByCell.get(treatmentCellId(row.itemId, column.id));
      const value = entry?.value ?? EMPTY_VALUE;
      const selected = new Set(value.optionIds);
      fields.push({
        id: treatmentCellId(row.itemId, column.id),
        code: treatmentCellCode(column.code, rowNumber),
        label: `${column.label} ${rowNumber}`,
        fieldType: column.fieldType,
        allowsFreeText: column.allowsFreeText,
        // A retired column stays visible, read-only (ADR-026).
        isActive: column.isActive,
        options: optionRows
          .filter((o) => o.listId === column.optionListId && (o.isActive || selected.has(o.id)))
          .map((o) => ({ id: o.id, label: o.label, isActive: o.isActive })),
        version: entry?.version ?? 0,
        value,
        optionListId: column.optionListId,
        saveUrl: `/api/visits/${visit.id}/treatment-plan/${row.itemId}/${column.id}`,
        optionFieldId: column.id,
      });
    }
  });

  return { visit, rows, fields };
}

export interface SaveTreatmentPlanCellInput extends SaveClinicalEntryInput {
  itemId: string;
}

export interface SaveTreatmentPlanCellResult {
  changed: boolean;
  replayed: boolean;
  version: number;
  value: ClinicalEntryValue;
  /** True when this save created the plan row. */
  createdItem: boolean;
}

/**
 * Saves one cell of one plan row as a NEW version (never in place). The first
 * non-empty save of a cell on an unknown row id creates the row for the
 * visit's patient, at the end of the plan. Same guarantees as
 * saveClinicalEntry: expectedVersion conflict (nothing written), replay of a
 * clientMutationId returns the original result, no-op saves write nothing,
 * closed visits are refused, every write is audited.
 */
export async function saveTreatmentPlanCell(
  db: Database,
  actor: ActorContext,
  input: SaveTreatmentPlanCellInput,
): Promise<SaveTreatmentPlanCellResult> {
  await requirePermission(db, actor, PERMISSIONS.CLINICAL_WRITE, {
    entityType: "treatment_plan_entry",
    entityId: input.itemId,
    visitId: input.visitId,
  });
  try {
    return await db.transaction((tx) => saveCellInTransaction(tx, actor, input));
  } catch (err) {
    if (isUniqueViolation(err) && pgErrorField(err, "constraint") === MUTATION_ID_INDEX) {
      throw new MutationIdReuseError();
    }
    throw err;
  }
}

async function saveCellInTransaction(
  tx: Database,
  actor: ActorContext,
  input: SaveTreatmentPlanCellInput,
): Promise<SaveTreatmentPlanCellResult> {
  // Lock order (never reversed => no deadlock): mutation id, visit, patient.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.clientMutationId}, 0))`);

  const [visit] = await tx
    .select({ id: visits.id, patientId: visits.patientId, status: visits.status })
    .from(visits)
    .where(eq(visits.id, input.visitId))
    .limit(1)
    .for("update");
  if (!visit) throw new VisitNotFoundError(input.visitId);

  const [applied] = await tx
    .select()
    .from(treatmentPlanEntries)
    .where(eq(treatmentPlanEntries.clientMutationId, input.clientMutationId))
    .limit(1);
  if (applied) {
    const canonical: ClinicalEntryValue = {
      optionIds: [...new Set(input.optionIds)].sort(),
      freeText: input.freeText.trim(),
      ...(input.checked === undefined ? {} : { checked: input.checked }),
    };
    if (
      applied.itemId !== input.itemId ||
      applied.visitId !== visit.id ||
      applied.fieldDefinitionId !== input.fieldId ||
      applied.createdBy !== actor.userId ||
      applied.version !== input.expectedVersion + 1 ||
      !valuesEqual(applied.value, canonical)
    ) {
      throw new MutationIdReuseError();
    }
    return { changed: false, replayed: true, version: applied.version, value: applied.value, createdItem: false };
  }

  if (visit.status !== "open") throw new VisitNotOpenError(visit.id, visit.status);

  const [field] = await tx
    .select()
    .from(clinicalFieldDefinitions)
    .where(and(eq(clinicalFieldDefinitions.id, input.fieldId), eq(clinicalFieldDefinitions.isActive, true)))
    .limit(1);
  if (!field || !isTreatmentPlanColumn(field.code)) throw new ClinicalFieldNotFoundError(input.fieldId);

  // Serialises row creation (positions) per patient.
  await tx.select({ id: patients.id }).from(patients).where(eq(patients.id, visit.patientId)).for("update");

  const [item] = await tx
    .select()
    .from(treatmentPlanItems)
    .where(eq(treatmentPlanItems.id, input.itemId))
    .limit(1);
  // Another patient's row is indistinguishable from a missing one.
  if (item && item.patientId !== visit.patientId) throw new TreatmentPlanItemNotFoundError(input.itemId);

  const [current] = item
    ? await tx
        .select()
        .from(treatmentPlanEntries)
        .where(and(eq(treatmentPlanEntries.itemId, item.id), eq(treatmentPlanEntries.fieldDefinitionId, field.id)))
        .orderBy(desc(treatmentPlanEntries.version))
        .limit(1)
    : [];
  const previousValue = current?.value ?? EMPTY_VALUE;
  const currentVersion = current?.version ?? 0;

  if (input.expectedVersion !== currentVersion) {
    throw new ClinicalConflictError({
      version: currentVersion,
      value: previousValue,
      options: await loadFieldOptions(tx, field, previousValue),
    });
  }

  const next = await normalizeValue(tx, field, input, previousValue);
  if (valuesEqual(previousValue, next)) {
    return { changed: false, replayed: false, version: currentVersion, value: previousValue, createdItem: false };
  }

  const meta = { ip: actor.ip ?? null, userAgent: actor.userAgent ?? null };
  let itemId = item?.id;
  let createdItem = false;
  if (!itemId) {
    const [max] = await tx
      .select({ value: sql<number>`coalesce(max(${treatmentPlanItems.position}), 0)` })
      .from(treatmentPlanItems)
      .where(eq(treatmentPlanItems.patientId, visit.patientId));
    const [createdRow] = await tx
      .insert(treatmentPlanItems)
      .values({
        id: input.itemId,
        patientId: visit.patientId,
        position: Number(max?.value ?? 0) + 1,
        createdInVisitId: visit.id,
        createdBy: actor.userId,
      })
      .returning();
    if (!createdRow) throw new Error("Failed to create treatment plan row");
    itemId = createdRow.id;
    createdItem = true;
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "treatment_plan_item.create",
      entityType: "treatment_plan_item",
      entityId: createdRow.id,
      patientId: visit.patientId,
      visitId: visit.id,
      after: createdRow,
      metadata: { ...meta, clientMutationId: input.clientMutationId },
    });
  }

  const [created] = await tx
    .insert(treatmentPlanEntries)
    .values({
      itemId,
      fieldDefinitionId: field.id,
      version: currentVersion + 1,
      value: next,
      visitId: visit.id,
      clientMutationId: input.clientMutationId,
      createdBy: actor.userId,
    })
    .returning();
  if (!created) throw new Error("Failed to save treatment plan cell");

  await writeAudit(tx, {
    actorUserId: actor.userId,
    action: current ? "treatment_plan_entry.update" : "treatment_plan_entry.create",
    entityType: "treatment_plan_entry",
    entityId: created.id,
    patientId: visit.patientId,
    visitId: visit.id,
    before: current ? { version: current.version, value: current.value } : null,
    after: { version: created.version, value: created.value },
    metadata: {
      ...meta,
      itemId,
      fieldCode: field.code,
      fieldDefinitionId: field.id,
      clientMutationId: input.clientMutationId,
    },
  });

  return { changed: true, replayed: false, version: created.version, value: created.value, createdItem };
}
