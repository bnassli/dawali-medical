import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  clinicalEntries,
  clinicalFieldDefinitions,
  clinicalOptionLists,
  clinicalOptions,
  clinicalSections,
  visits,
  type ClinicalEntryValue,
} from "@/db/schema";
import { writeAudit } from "@/modules/audit/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { requirePermission } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import { FIELD_TYPES, isSelectType } from "./definitions";
import type {
  AddClinicalOptionInput,
  SaveClinicalEntryInput,
  SetClinicalOptionActiveInput,
} from "./schema";

export class VisitNotFoundError extends Error {
  constructor(visitId: string) {
    super(`Visit ${visitId} does not exist.`);
    this.name = "VisitNotFoundError";
  }
}

export class VisitNotOpenError extends Error {
  constructor(visitId: string, status: string) {
    super(
      `Visit ${visitId} is ${status}; clinical entries can only be changed while a visit is open.`,
    );
    this.name = "VisitNotOpenError";
  }
}

export class ClinicalSectionNotFoundError extends Error {
  constructor(code: string) {
    super(`Clinical section "${code}" does not exist.`);
    this.name = "ClinicalSectionNotFoundError";
  }
}

export class ClinicalFieldNotFoundError extends Error {
  constructor(fieldId: string) {
    super(`Clinical field ${fieldId} does not exist or is not active.`);
    this.name = "ClinicalFieldNotFoundError";
  }
}

export class ClinicalOptionNotFoundError extends Error {
  constructor(optionId: string) {
    super(`Clinical option ${optionId} does not exist.`);
    this.name = "ClinicalOptionNotFoundError";
  }
}

export class InvalidClinicalValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidClinicalValueError";
  }
}

export class DuplicateOptionError extends Error {
  constructor(label: string) {
    super(
      `An option "${label}" already exists in this list (it may be retired — ask an administrator to reactivate it).`,
    );
    this.name = "DuplicateOptionError";
  }
}

function isUniqueViolation(err: unknown): boolean {
  const codeOf = (e: unknown): unknown =>
    typeof e === "object" && e !== null && "code" in e
      ? (e as { code?: unknown }).code
      : undefined;
  const cause =
    typeof err === "object" && err !== null && "cause" in err
      ? (err as { cause?: unknown }).cause
      : undefined;
  return codeOf(err) === "23505" || codeOf(cause) === "23505";
}

export interface ClinicalOptionView {
  id: string;
  label: string;
  isActive: boolean;
}

export interface ClinicalFieldView {
  id: string;
  code: string;
  label: string;
  fieldType: string;
  allowsFreeText: boolean;
  options: ClinicalOptionView[];
  version: number;
  value: ClinicalEntryValue;
}

export interface ClinicalSectionView {
  section: { id: string; code: string; name: string };
  visit: { id: string; patientId: string; status: string };
  fields: ClinicalFieldView[];
}

export interface ClinicalEntryRecord {
  id: string;
  visitId: string;
  fieldDefinitionId: string;
  version: number;
  value: ClinicalEntryValue;
  createdAt: Date;
}

const EMPTY_VALUE: ClinicalEntryValue = { optionIds: [], freeText: "" };

function valuesEqual(a: ClinicalEntryValue, b: ClinicalEntryValue): boolean {
  return (
    a.freeText === b.freeText &&
    a.optionIds.length === b.optionIds.length &&
    a.optionIds.every((id, i) => id === b.optionIds[i])
  );
}

/**
 * Loads a clinical section for a visit with the current (highest-version)
 * value of every field and each field's options. Options that were retired
 * after being selected on this visit are still returned so the saved value
 * keeps rendering.
 */
export async function getClinicalSectionForVisit(
  db: Database,
  actor: ActorContext,
  visitId: string,
  sectionCode: string,
): Promise<ClinicalSectionView> {
  await requirePermission(db, actor, PERMISSIONS.CLINICAL_READ, {
    entityType: "clinical_entry",
    entityId: visitId,
    visitId,
  });

  const [visit] = await db
    .select({ id: visits.id, patientId: visits.patientId, status: visits.status })
    .from(visits)
    .where(eq(visits.id, visitId))
    .limit(1);
  if (!visit) throw new VisitNotFoundError(visitId);

  const [section] = await db
    .select()
    .from(clinicalSections)
    .where(eq(clinicalSections.code, sectionCode))
    .limit(1);
  if (!section) throw new ClinicalSectionNotFoundError(sectionCode);

  const fields = await db
    .select()
    .from(clinicalFieldDefinitions)
    .where(
      and(
        eq(clinicalFieldDefinitions.sectionId, section.id),
        eq(clinicalFieldDefinitions.isActive, true),
      ),
    )
    .orderBy(asc(clinicalFieldDefinitions.sortOrder));

  const fieldIds = fields.map((f) => f.id);
  const currentEntries =
    fieldIds.length === 0
      ? []
      : await db
          .selectDistinctOn([clinicalEntries.fieldDefinitionId])
          .from(clinicalEntries)
          .where(
            and(
              eq(clinicalEntries.visitId, visitId),
              inArray(clinicalEntries.fieldDefinitionId, fieldIds),
            ),
          )
          .orderBy(clinicalEntries.fieldDefinitionId, desc(clinicalEntries.version));
  const entryByField = new Map(currentEntries.map((e) => [e.fieldDefinitionId, e]));

  const listIds = fields.map((f) => f.optionListId).filter((v): v is string => v !== null);
  const optionRows =
    listIds.length === 0
      ? []
      : await db
          .select()
          .from(clinicalOptions)
          .where(inArray(clinicalOptions.listId, listIds))
          .orderBy(asc(clinicalOptions.sortOrder), asc(clinicalOptions.label));

  const views: ClinicalFieldView[] = fields.map((field) => {
    const entry = entryByField.get(field.id);
    const value = entry?.value ?? EMPTY_VALUE;
    const selected = new Set(value.optionIds);
    const options = optionRows
      .filter((o) => o.listId === field.optionListId && (o.isActive || selected.has(o.id)))
      .map((o) => ({ id: o.id, label: o.label, isActive: o.isActive }));
    return {
      id: field.id,
      code: field.code,
      label: field.label,
      fieldType: field.fieldType,
      allowsFreeText: field.allowsFreeText,
      options,
      version: entry?.version ?? 0,
      value,
    };
  });

  return {
    section: { id: section.id, code: section.code, name: section.name },
    visit,
    fields: views,
  };
}

/**
 * Saves one field of one visit as a NEW version row (never updates in place).
 * Returns `changed: false` (and writes nothing) when the normalised value is
 * identical to the current one, so repeated auto-save calls do not bloat
 * history or the audit log.
 */
export async function saveClinicalEntry(
  db: Database,
  actor: ActorContext,
  input: SaveClinicalEntryInput,
): Promise<{ changed: boolean; entry: ClinicalEntryRecord | null }> {
  await requirePermission(db, actor, PERMISSIONS.CLINICAL_WRITE, {
    entityType: "clinical_entry",
    entityId: input.fieldId,
    visitId: input.visitId,
  });

  return db.transaction(async (tx) => {
    // Row lock serialises saves per visit (version numbering) and makes the
    // status check race-free against a concurrent status change.
    const [visit] = await tx
      .select({ id: visits.id, patientId: visits.patientId, status: visits.status })
      .from(visits)
      .where(eq(visits.id, input.visitId))
      .limit(1)
      .for("update");
    if (!visit) throw new VisitNotFoundError(input.visitId);
    if (visit.status !== "open") throw new VisitNotOpenError(visit.id, visit.status);

    const [field] = await tx
      .select()
      .from(clinicalFieldDefinitions)
      .where(
        and(
          eq(clinicalFieldDefinitions.id, input.fieldId),
          eq(clinicalFieldDefinitions.isActive, true),
        ),
      )
      .limit(1);
    if (!field) throw new ClinicalFieldNotFoundError(input.fieldId);

    const [current] = await tx
      .select()
      .from(clinicalEntries)
      .where(
        and(
          eq(clinicalEntries.visitId, input.visitId),
          eq(clinicalEntries.fieldDefinitionId, field.id),
        ),
      )
      .orderBy(desc(clinicalEntries.version))
      .limit(1);

    const previousValue = current?.value ?? EMPTY_VALUE;
    const next = await normalizeValue(tx, field, input, previousValue);

    if (valuesEqual(previousValue, next)) {
      return { changed: false, entry: current ?? null };
    }

    const version = (current?.version ?? 0) + 1;
    const [created] = await tx
      .insert(clinicalEntries)
      .values({
        visitId: visit.id,
        fieldDefinitionId: field.id,
        version,
        value: next,
        createdBy: actor.userId,
      })
      .returning();
    if (!created) throw new Error("Failed to save clinical entry");

    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: current ? "clinical_entry.update" : "clinical_entry.create",
      entityType: "clinical_entry",
      entityId: created.id,
      patientId: visit.patientId,
      visitId: visit.id,
      before: current
        ? { version: current.version, value: current.value }
        : null,
      after: { version: created.version, value: created.value },
      metadata: {
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        fieldCode: field.code,
        fieldDefinitionId: field.id,
      },
    });

    return { changed: true, entry: created };
  });
}

async function normalizeValue(
  tx: Database,
  field: typeof clinicalFieldDefinitions.$inferSelect,
  input: SaveClinicalEntryInput,
  previous: ClinicalEntryValue,
): Promise<ClinicalEntryValue> {
  const freeText = input.freeText.trim();
  const optionIds = [...new Set(input.optionIds)].sort();

  if (field.fieldType === FIELD_TYPES.TEXT || field.fieldType === FIELD_TYPES.TEXTAREA) {
    if (optionIds.length > 0) {
      throw new InvalidClinicalValueError(`Field "${field.label}" does not take options.`);
    }
    return { optionIds: [], freeText };
  }

  if (!isSelectType(field.fieldType) || !field.optionListId) {
    throw new InvalidClinicalValueError(`Field "${field.label}" is misconfigured.`);
  }
  if (field.fieldType === FIELD_TYPES.SELECT && optionIds.length > 1) {
    throw new InvalidClinicalValueError(`Field "${field.label}" accepts a single option.`);
  }
  if (freeText !== "" && !field.allowsFreeText) {
    throw new InvalidClinicalValueError(`Field "${field.label}" does not accept free text.`);
  }

  if (optionIds.length > 0) {
    const rows = await tx
      .select({ id: clinicalOptions.id, isActive: clinicalOptions.isActive })
      .from(clinicalOptions)
      .where(
        and(
          eq(clinicalOptions.listId, field.optionListId),
          inArray(clinicalOptions.id, optionIds),
        ),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const previouslySelected = new Set(previous.optionIds);
    for (const id of optionIds) {
      const row = byId.get(id);
      if (!row) {
        throw new InvalidClinicalValueError(
          `Option ${id} does not belong to field "${field.label}".`,
        );
      }
      // A retired option can stay selected if it already was, but cannot be newly chosen.
      if (!row.isActive && !previouslySelected.has(id)) {
        throw new InvalidClinicalValueError(`Option ${id} is retired and cannot be selected.`);
      }
    }
  }

  return { optionIds, freeText };
}

/**
 * "+ Add New": permanently adds an option to the field's option list.
 * Visit-only free text is NOT added here; it is stored on the entry itself.
 */
export async function addClinicalOption(
  db: Database,
  actor: ActorContext,
  input: AddClinicalOptionInput,
): Promise<ClinicalOptionView> {
  await requirePermission(db, actor, PERMISSIONS.CLINICAL_OPTION_ADD, {
    entityType: "clinical_option",
    entityId: input.fieldId,
  });

  const label = input.label.trim();

  try {
    return await db.transaction(async (tx) => {
      const [field] = await tx
        .select()
        .from(clinicalFieldDefinitions)
        .where(
          and(
            eq(clinicalFieldDefinitions.id, input.fieldId),
            eq(clinicalFieldDefinitions.isActive, true),
          ),
        )
        .limit(1);
      if (!field || !field.optionListId || !isSelectType(field.fieldType)) {
        throw new ClinicalFieldNotFoundError(input.fieldId);
      }

      const [duplicate] = await tx
        .select({ id: clinicalOptions.id })
        .from(clinicalOptions)
        .where(
          and(
            eq(clinicalOptions.listId, field.optionListId),
            sql`lower(${clinicalOptions.label}) = lower(${label})`,
          ),
        )
        .limit(1);
      if (duplicate) throw new DuplicateOptionError(label);

      const [max] = await tx
        .select({ value: sql<number>`coalesce(max(${clinicalOptions.sortOrder}), 0)` })
        .from(clinicalOptions)
        .where(eq(clinicalOptions.listId, field.optionListId));

      const [created] = await tx
        .insert(clinicalOptions)
        .values({
          listId: field.optionListId,
          label,
          sortOrder: Number(max?.value ?? 0) + 1,
          createdBy: actor.userId,
        })
        .returning();
      if (!created) throw new Error("Failed to create clinical option");

      await writeAudit(tx, {
        actorUserId: actor.userId,
        action: "clinical_option.create",
        entityType: "clinical_option",
        entityId: created.id,
        after: created,
        metadata: {
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          fieldCode: field.code,
          optionListId: field.optionListId,
        },
      });

      return { id: created.id, label: created.label, isActive: created.isActive };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateOptionError(label);
    throw err;
  }
}

/** Retires or reactivates an option. Options are never renamed or deleted. */
export async function setClinicalOptionActive(
  db: Database,
  actor: ActorContext,
  input: SetClinicalOptionActiveInput,
): Promise<void> {
  await requirePermission(db, actor, PERMISSIONS.CLINICAL_OPTION_MANAGE, {
    entityType: "clinical_option",
    entityId: input.optionId,
  });

  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(clinicalOptions)
      .where(eq(clinicalOptions.id, input.optionId))
      .limit(1)
      .for("update");
    if (!before) throw new ClinicalOptionNotFoundError(input.optionId);
    if (before.isActive === input.isActive) return;

    const [after] = await tx
      .update(clinicalOptions)
      .set({ isActive: input.isActive })
      .where(eq(clinicalOptions.id, input.optionId))
      .returning();
    if (!after) throw new Error("Failed to update clinical option");

    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "clinical_option.update",
      entityType: "clinical_option",
      entityId: after.id,
      before,
      after,
      metadata: { ip: actor.ip ?? null, userAgent: actor.userAgent ?? null },
    });
  });
}

export interface OptionListAdminView {
  id: string;
  code: string;
  name: string;
  options: ClinicalOptionView[];
}

export async function listOptionListsForAdmin(
  db: Database,
  actor: ActorContext,
): Promise<OptionListAdminView[]> {
  await requirePermission(db, actor, PERMISSIONS.CLINICAL_OPTION_MANAGE, {
    entityType: "clinical_option",
  });

  const lists = await db
    .select()
    .from(clinicalOptionLists)
    .orderBy(asc(clinicalOptionLists.code));
  const options = await db
    .select()
    .from(clinicalOptions)
    .orderBy(asc(clinicalOptions.sortOrder), asc(clinicalOptions.label));

  return lists.map((list) => ({
    id: list.id,
    code: list.code,
    name: list.name,
    options: options
      .filter((o) => o.listId === list.id)
      .map((o) => ({ id: o.id, label: o.label, isActive: o.isActive })),
  }));
}
