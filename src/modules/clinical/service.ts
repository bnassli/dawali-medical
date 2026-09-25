import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  clinicalEntries,
  clinicalFieldDefinitions,
  clinicalOptionLists,
  clinicalOptions,
  clinicalSectionFields,
  clinicalSections,
  patients,
  visits,
  type ClinicalEntryValue,
} from "@/db/schema";
import { writeAudit } from "@/modules/audit/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { requirePermission } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import {
  FEMALE_ONLY_FIELD_CODES,
  FIELD_EXCLUSION_RULES,
  FIELD_TYPES,
  FIXED_CHOICES,
  isSelectType,
  NUMERIC_FIELD_RULES,
  TREATMENT_PLAN_COLUMN_CODES,
  type NumericFieldRule,
} from "./definitions";
import {
  characterCount,
  MAX_FREE_TEXT_LENGTH,
  type AddClinicalOptionInput,
  type SaveClinicalEntryInput,
  type SetClinicalOptionActiveInput,
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

export interface ClinicalConflictDetails {
  version: number;
  value: ClinicalEntryValue;
  options: ClinicalOptionView[];
}

/**
 * The client's expectedVersion no longer matches the stored current version:
 * someone else saved this field first. Nothing is written (no revision, no
 * audit row) and the other user's value is left untouched.
 */
export class ClinicalConflictError extends Error {
  readonly current: ClinicalConflictDetails;
  constructor(current: ClinicalConflictDetails) {
    super(
      "This field was changed by someone else since you loaded it. Choose Keep mine or Use theirs.",
    );
    this.name = "ClinicalConflictError";
    this.current = current;
  }
}

export class MutationIdReuseError extends Error {
  constructor() {
    super("clientMutationId was already used for a different change.");
    this.name = "MutationIdReuseError";
  }
}

/**
 * A value that may not coexist with another field's current value on the same
 * visit (ADR-027), e.g. "Unknown" together with Past Medical Hx values.
 * Nothing is written and nothing on the other field is changed.
 */
export class ClinicalExclusionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClinicalExclusionError";
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

export function pgErrorField(err: unknown, field: "code" | "constraint"): unknown {
  const read = (e: unknown): unknown =>
    typeof e === "object" && e !== null && field in e
      ? (e as Record<string, unknown>)[field]
      : undefined;
  const cause =
    typeof err === "object" && err !== null && "cause" in err
      ? (err as { cause?: unknown }).cause
      : undefined;
  return read(err) ?? read(cause);
}

export function isUniqueViolation(err: unknown): boolean {
  return pgErrorField(err, "code") === "23505";
}

const MUTATION_ID_INDEX = "clinical_entries_client_mutation_id_idx";

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
  /**
   * False for a retired field that still has history on this visit: it is
   * shown read-only so recorded data never disappears (ADR-026).
   */
  isActive: boolean;
  options: ClinicalOptionView[];
  version: number;
  value: ClinicalEntryValue;
  /** The option list, so fields sharing it see an option added from any of them. */
  optionListId?: string | null;
  /**
   * Treatment Plan cells (ADR-030) are not visit entries: they save to their own
   * URL and add options through their column field. Absent for ordinary fields.
   */
  saveUrl?: string;
  optionFieldId?: string;
}

export interface ClinicalSectionView {
  section: { id: string; code: string; name: string };
  /** `patientSex` ('F' | 'M' | null) drives female-only fields (ADR-029). */
  visit: { id: string; patientId: string; status: string; patientSex: string | null };
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

export const EMPTY_VALUE: ClinicalEntryValue = { optionIds: [], freeText: "" };

function isEmptyValue(v: ClinicalEntryValue): boolean {
  return v.optionIds.length === 0 && v.freeText === "" && v.checked !== true;
}

export function valuesEqual(a: ClinicalEntryValue, b: ClinicalEntryValue): boolean {
  return (
    a.freeText === b.freeText &&
    (a.checked ?? false) === (b.checked ?? false) &&
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
    .select({
      id: visits.id,
      patientId: visits.patientId,
      status: visits.status,
      patientSex: patients.sex,
    })
    .from(visits)
    .innerJoin(patients, eq(patients.id, visits.patientId))
    .where(eq(visits.id, visitId))
    .limit(1);
  if (!visit) throw new VisitNotFoundError(visitId);

  const [section] = await db
    .select()
    .from(clinicalSections)
    .where(eq(clinicalSections.code, sectionCode))
    .limit(1);
  if (!section) throw new ClinicalSectionNotFoundError(sectionCode);

  // Global fields placed in this section, in placement order.
  const placements = await db
    .select({ field: clinicalFieldDefinitions, labelOverride: clinicalSectionFields.labelOverride })
    .from(clinicalSectionFields)
    .innerJoin(
      clinicalFieldDefinitions,
      eq(clinicalFieldDefinitions.id, clinicalSectionFields.fieldDefinitionId),
    )
    .where(eq(clinicalSectionFields.sectionId, section.id))
    .orderBy(asc(clinicalSectionFields.sortOrder), asc(clinicalFieldDefinitions.code));

  const placedIds = placements.map((p) => p.field.id);
  const currentEntries =
    placedIds.length === 0
      ? []
      : await db
          .selectDistinctOn([clinicalEntries.fieldDefinitionId])
          .from(clinicalEntries)
          .where(
            and(
              eq(clinicalEntries.visitId, visitId),
              inArray(clinicalEntries.fieldDefinitionId, placedIds),
            ),
          )
          .orderBy(clinicalEntries.fieldDefinitionId, desc(clinicalEntries.version));
  const entryByField = new Map(currentEntries.map((e) => [e.fieldDefinitionId, e]));

  // Active fields, plus retired fields that still have history on this visit
  // (shown read-only so history never disappears).
  const labelOverrideById = new Map(placements.map((p) => [p.field.id, p.labelOverride]));
  const fields = placements
    .map((p) => p.field)
    .filter((f) => f.isActive || entryByField.has(f.id));

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
      // The tab's own label (e.g. "Family Medical Hx") over the global one (ADR-027).
      label: labelOverrideById.get(field.id) ?? field.label,
      fieldType: field.fieldType,
      allowsFreeText: field.allowsFreeText,
      isActive: field.isActive,
      options,
      version: entry?.version ?? 0,
      value,
      optionListId: field.optionListId,
    };
  });

  return {
    section: { id: section.id, code: section.code, name: section.name },
    visit,
    fields: views,
  };
}

export interface ClinicalSectionTab {
  id: string;
  code: string;
  name: string;
}

/** The clinical tabs, in display order (data-driven; ADR-027). Requires clinical.read. */
export async function listClinicalSections(
  db: Database,
  actor: ActorContext,
): Promise<ClinicalSectionTab[]> {
  await requirePermission(db, actor, PERMISSIONS.CLINICAL_READ, {
    entityType: "clinical_entry",
  });
  return db
    .select({ id: clinicalSections.id, code: clinicalSections.code, name: clinicalSections.name })
    .from(clinicalSections)
    .orderBy(asc(clinicalSections.sortOrder), asc(clinicalSections.code));
}

export interface SaveClinicalEntryResult {
  /** True only when a new revision row was inserted by THIS call. */
  changed: boolean;
  /** True when clientMutationId was already applied; the original result is returned. */
  replayed: boolean;
  /** Version the client should treat as its new base version. */
  version: number;
  value: ClinicalEntryValue;
  entry: ClinicalEntryRecord | null;
}

/**
 * Saves one field of one visit as a NEW version row (never updates in place).
 *
 * Concurrency: `expectedVersion` is the version the client last saw (0 = no
 * entry yet). If it differs from the stored current version the save is
 * rejected with ClinicalConflictError and NOTHING is written (no revision, no
 * audit row) — last-write-wins is never allowed.
 *
 * Idempotency: `clientMutationId` is recorded on the revision it creates. A
 * replay of the same id (same visit, field and actor) returns the original
 * result and writes nothing. A save whose normalised value equals the current
 * value also writes nothing (no revision, no audit row).
 */
export async function saveClinicalEntry(
  db: Database,
  actor: ActorContext,
  input: SaveClinicalEntryInput,
): Promise<SaveClinicalEntryResult> {
  await requirePermission(db, actor, PERMISSIONS.CLINICAL_WRITE, {
    entityType: "clinical_entry",
    entityId: input.fieldId,
    visitId: input.visitId,
  });

  try {
    return await db.transaction((tx) => saveInTransaction(tx, actor, input));
  } catch (err) {
    // Belt and braces: the advisory lock below already serialises concurrent
    // reuse of one clientMutationId; if the unique index still fires, the
    // outcome is the same deterministic 400, never a 500.
    if (isUniqueViolation(err) && pgErrorField(err, "constraint") === MUTATION_ID_INDEX) {
      throw new MutationIdReuseError();
    }
    throw err;
  }
}

async function saveInTransaction(
  tx: Database,
  actor: ActorContext,
  input: SaveClinicalEntryInput,
): Promise<SaveClinicalEntryResult> {
  // Serialise everything that uses this clientMutationId, across visits and
  // users, so a concurrent reuse is decided deterministically by the check
  // below instead of racing into the unique index. Always taken BEFORE the
  // visit row lock (fixed lock order => no deadlock).
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.clientMutationId}, 0))`,
  );

  // Row lock serialises saves per visit (version numbering) and makes the
  // status check race-free against a concurrent status change.
  const [visit] = await tx
    .select({ id: visits.id, patientId: visits.patientId, status: visits.status })
    .from(visits)
    .where(eq(visits.id, input.visitId))
    .limit(1)
    .for("update");
  if (!visit) throw new VisitNotFoundError(input.visitId);

  // Replay of an already-applied mutation: return the original result, but
  // ONLY if it is genuinely the same request — same visit, field and user,
  // same base version and the same canonical value. Anything else is reuse
  // of the id for a different change and is rejected.
  const [applied] = await tx
    .select()
    .from(clinicalEntries)
    .where(eq(clinicalEntries.clientMutationId, input.clientMutationId))
    .limit(1);
  if (applied) {
    const canonical: ClinicalEntryValue = {
      optionIds: [...new Set(input.optionIds)].sort(),
      freeText: input.freeText.trim(),
      ...(input.checked === undefined ? {} : { checked: input.checked }),
    };
    if (
      applied.visitId !== visit.id ||
      applied.fieldDefinitionId !== input.fieldId ||
      applied.createdBy !== actor.userId ||
      applied.version !== input.expectedVersion + 1 ||
      !valuesEqual(applied.value, canonical)
    ) {
      throw new MutationIdReuseError();
    }
    return {
      changed: false,
      replayed: true,
      version: applied.version,
      value: applied.value,
      entry: applied,
    };
  }

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
  // Treatment Plan columns are saved per plan row, never as visit entries (ADR-030).
  if (!field || isTreatmentPlanColumn(field.code)) throw new ClinicalFieldNotFoundError(input.fieldId);

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
    return {
      changed: false,
      replayed: false,
      version: currentVersion,
      value: previousValue,
      entry: current ?? null,
    };
  }

  await assertNoExclusion(tx, visit.id, field, next);
  await assertFemaleOnly(tx, visit.patientId, field, next);

  const version = currentVersion + 1;
  const [created] = await tx
    .insert(clinicalEntries)
    .values({
      visitId: visit.id,
      fieldDefinitionId: field.id,
      version,
      value: next,
      clientMutationId: input.clientMutationId,
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
      clientMutationId: input.clientMutationId,
    },
  });

  return {
    changed: true,
    replayed: false,
    version: created.version,
    value: created.value,
    entry: created,
  };
}

/** Options of a field's list; retired ones only when the given value selects them. */
export async function loadFieldOptions(
  db: Database,
  field: typeof clinicalFieldDefinitions.$inferSelect,
  value: ClinicalEntryValue,
): Promise<ClinicalOptionView[]> {
  if (!field.optionListId) return [];
  const rows = await db
    .select()
    .from(clinicalOptions)
    .where(eq(clinicalOptions.listId, field.optionListId))
    .orderBy(asc(clinicalOptions.sortOrder), asc(clinicalOptions.label));
  const selected = new Set(value.optionIds);
  return rows
    .filter((o) => o.isActive || selected.has(o.id))
    .map((o) => ({ id: o.id, label: o.label, isActive: o.isActive }));
}

const REASON_FIELD_CODE = "reason_for_visit";

async function loadReasonField(db: Database) {
  const [field] = await db
    .select()
    .from(clinicalFieldDefinitions)
    .where(eq(clinicalFieldDefinitions.code, REASON_FIELD_CODE))
    .limit(1);
  if (!field) {
    throw new Error("Reason for Visit field definition is missing — run db:migrate and db:seed.");
  }
  return field;
}

/**
 * Records the reason typed at visit creation as version 1 of the
 * reason_for_visit clinical entry — the ONLY place Reason for Visit is stored
 * (ADR-024). Must be called inside the visit-creation transaction, so the
 * entry and its audit row commit atomically with the visit. The caller must
 * already have checked clinical.write.
 */
export async function recordInitialReasonForVisit(
  tx: Database,
  actor: ActorContext,
  visit: { id: string; patientId: string },
  reason: string,
): Promise<void> {
  const text = reason.trim();
  if (!text) return;
  // Defense in depth: the form and schema enforce the same limit.
  if (characterCount(text) > MAX_FREE_TEXT_LENGTH) {
    throw new InvalidClinicalValueError(
      `Reason for visit must be at most ${MAX_FREE_TEXT_LENGTH} characters.`,
    );
  }
  const field = await loadReasonField(tx);
  const [created] = await tx
    .insert(clinicalEntries)
    .values({
      visitId: visit.id,
      fieldDefinitionId: field.id,
      version: 1,
      value: { optionIds: [], freeText: text },
      createdBy: actor.userId,
    })
    .returning();
  if (!created) throw new Error("Failed to record reason for visit");

  await writeAudit(tx, {
    actorUserId: actor.userId,
    action: "clinical_entry.create",
    entityType: "clinical_entry",
    entityId: created.id,
    patientId: visit.patientId,
    visitId: visit.id,
    before: null,
    after: { version: 1, value: created.value },
    metadata: {
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      fieldCode: field.code,
      fieldDefinitionId: field.id,
      source: "visit.create",
    },
  });
}

/**
 * Current Reason for Visit text per visit, read from clinical_entries (the
 * only source). Requires clinical.read; visits without a reason are absent.
 */
export async function getVisitReasons(
  db: Database,
  actor: ActorContext,
  visitIds: string[],
): Promise<Map<string, string>> {
  await requirePermission(db, actor, PERMISSIONS.CLINICAL_READ, {
    entityType: "clinical_entry",
  });
  const result = new Map<string, string>();
  if (visitIds.length === 0) return result;

  const field = await loadReasonField(db);
  const entries = await db
    .selectDistinctOn([clinicalEntries.visitId])
    .from(clinicalEntries)
    .where(
      and(
        inArray(clinicalEntries.visitId, visitIds),
        eq(clinicalEntries.fieldDefinitionId, field.id),
      ),
    )
    .orderBy(clinicalEntries.visitId, desc(clinicalEntries.version));

  const optionIds = [...new Set(entries.flatMap((e) => e.value.optionIds))];
  const labels = new Map<string, string>();
  if (optionIds.length > 0) {
    const rows = await db
      .select({ id: clinicalOptions.id, label: clinicalOptions.label })
      .from(clinicalOptions)
      .where(inArray(clinicalOptions.id, optionIds));
    for (const r of rows) labels.set(r.id, r.label);
  }

  for (const e of entries) {
    const parts = [
      ...e.value.optionIds.map((id) => labels.get(id)).filter((l): l is string => !!l),
      e.value.freeText,
    ].filter((p) => p !== "");
    if (parts.length > 0) result.set(e.visitId, parts.join("; "));
  }
  return result;
}

/**
 * Enforces FIELD_EXCLUSION_RULES against the other fields' CURRENT values on
 * this visit. Runs inside the save transaction, under the visit row lock, so
 * two concurrent saves on one visit cannot both pass. Only a value that is
 * "active" (checked flag / non-empty excluded field) is checked: clearing is
 * always allowed, and an already-inconsistent pair can always be resolved.
 */
async function assertNoExclusion(
  tx: Database,
  visitId: string,
  field: typeof clinicalFieldDefinitions.$inferSelect,
  next: ClinicalEntryValue,
): Promise<void> {
  const currentByCode = async (code: string) => {
    const [row] = await tx
      .select({ value: clinicalEntries.value, label: clinicalFieldDefinitions.label })
      .from(clinicalEntries)
      .innerJoin(
        clinicalFieldDefinitions,
        eq(clinicalFieldDefinitions.id, clinicalEntries.fieldDefinitionId),
      )
      .where(and(eq(clinicalEntries.visitId, visitId), eq(clinicalFieldDefinitions.code, code)))
      .orderBy(desc(clinicalEntries.version))
      .limit(1);
    return row ?? null;
  };

  for (const rule of FIELD_EXCLUSION_RULES) {
    if (rule.flag === field.code && next.checked === true) {
      for (const code of rule.excludes) {
        const other = await currentByCode(code);
        if (other && !isEmptyValue(other.value)) {
          throw new ClinicalExclusionError(
            `"${field.label}" cannot be set while "${other.label}" has values. Clear "${other.label}" first.`,
          );
        }
      }
    }
    if (rule.excludes.includes(field.code) && !isEmptyValue(next)) {
      const flag = await currentByCode(rule.flag);
      if (flag?.value.checked === true) {
        throw new ClinicalExclusionError(
          `"${field.label}" cannot have values while "${flag.label}" is checked. Uncheck "${flag.label}" first.`,
        );
      }
    }
  }
}

/**
 * Female-only fields (FEMALE_ONLY_FIELD_CODES) refuse a non-empty value unless
 * the patient's sex is 'F'. Clearing is always allowed, so a value left over
 * from before a sex correction can still be removed (ADR-029).
 */
async function assertFemaleOnly(
  tx: Database,
  patientId: string,
  field: typeof clinicalFieldDefinitions.$inferSelect,
  next: ClinicalEntryValue,
): Promise<void> {
  if (!FEMALE_ONLY_FIELD_CODES.includes(field.code) || isEmptyValue(next)) return;
  const [patient] = await tx
    .select({ sex: patients.sex })
    .from(patients)
    .where(eq(patients.id, patientId))
    .limit(1);
  if (patient?.sex !== "F") {
    throw new InvalidClinicalValueError(`"${field.label}" applies to female patients only.`);
  }
}

/**
 * Canonical decimal text for a number field: no leading zeros or trailing
 * decimal zeros ("034.0" -> "34"), empty string for "no value".
 */
export function normalizeNumber(raw: string, rule: NumericFieldRule, label: string): string {
  const text = raw.trim();
  if (text === "") return "";
  const pattern = rule.decimals > 0 ? new RegExp(`^\\d{1,6}(\\.\\d{1,${rule.decimals}})?$`) : /^\d{1,6}$/;
  if (!pattern.test(text)) {
    throw new InvalidClinicalValueError(
      `"${label}" must be a number with at most ${rule.decimals} decimal place${rule.decimals === 1 ? "" : "s"}.`,
    );
  }
  const n = Number(text);
  if (n < rule.min || n > rule.max) {
    throw new InvalidClinicalValueError(
      `"${label}" must be between ${rule.min} and ${rule.max} ${rule.unit}.`,
    );
  }
  return String(n);
}

export function isTreatmentPlanColumn(code: string): boolean {
  return (TREATMENT_PLAN_COLUMN_CODES as readonly string[]).includes(code);
}

/** A `date` field value: "" or a real calendar date as ISO YYYY-MM-DD (years 1900-2100). */
export function normalizeIsoDate(raw: string, label: string): string {
  const text = raw.trim();
  if (text === "") return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const [y, mo, d] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (
    !m ||
    y < 1900 ||
    y > 2100 ||
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d
  ) {
    throw new InvalidClinicalValueError(`"${label}" must be a real date (day/month/year).`);
  }
  return text;
}

export async function normalizeValue(
  tx: Database,
  field: typeof clinicalFieldDefinitions.$inferSelect,
  input: SaveClinicalEntryInput,
  previous: ClinicalEntryValue,
): Promise<ClinicalEntryValue> {
  const freeText = input.freeText.trim();
  if (characterCount(freeText) > MAX_FREE_TEXT_LENGTH) {
    throw new InvalidClinicalValueError(`Text must be at most ${MAX_FREE_TEXT_LENGTH} characters.`);
  }
  const optionIds = [...new Set(input.optionIds)].sort();

  if (field.fieldType === FIELD_TYPES.CHECKBOX) {
    if (optionIds.length > 0 || freeText !== "") {
      throw new InvalidClinicalValueError(`Field "${field.label}" is a checkbox.`);
    }
    if (input.checked === undefined) {
      throw new InvalidClinicalValueError(`Field "${field.label}" requires checked true or false.`);
    }
    return { optionIds: [], freeText: "", checked: input.checked };
  }
  if (input.checked !== undefined) {
    throw new InvalidClinicalValueError(`Field "${field.label}" is not a checkbox.`);
  }

  if (field.fieldType === FIELD_TYPES.NUMBER || field.fieldType === FIELD_TYPES.CHOICE) {
    if (optionIds.length > 0) {
      throw new InvalidClinicalValueError(`Field "${field.label}" does not take options.`);
    }
    if (field.fieldType === FIELD_TYPES.NUMBER) {
      const rule = NUMERIC_FIELD_RULES[field.code];
      if (!rule) throw new InvalidClinicalValueError(`Field "${field.label}" is misconfigured.`);
      return { optionIds: [], freeText: normalizeNumber(freeText, rule, field.label) };
    }
    const choices = FIXED_CHOICES[field.code] ?? [];
    if (freeText !== "" && !choices.some((c) => c.value === freeText)) {
      throw new InvalidClinicalValueError(
        `"${field.label}" must be one of: ${choices.map((c) => c.value).join(", ")}.`,
      );
    }
    return { optionIds: [], freeText };
  }

  if (field.fieldType === FIELD_TYPES.DATE) {
    if (optionIds.length > 0) {
      throw new InvalidClinicalValueError(`Field "${field.label}" does not take options.`);
    }
    return { optionIds: [], freeText: normalizeIsoDate(freeText, field.label) };
  }

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
