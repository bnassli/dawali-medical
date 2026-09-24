import { and, asc, eq, ilike, inArray, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "@/db/client";
import { demographicOptions, patientExternalIds, patients } from "@/db/schema";
import { writeAudit, type Tx } from "@/modules/audit/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { requirePermission } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import {
  DEMOGRAPHIC_LIST_NAMES,
  EXTERNAL_ID_SYSTEMS,
  type DemographicListCode,
  type ExternalIdSystem,
} from "./constants";
import type {
  AddDemographicOptionInput,
  CreatePatientInput,
  SearchPatientsInput,
  SetDemographicOptionActiveInput,
  SetPatientActiveInput,
  UpdatePatientInput,
} from "./schema";

export class DuplicateExternalIdError extends Error {
  constructor(system: string, value: string) {
    super(
      `A patient already exists with ${system} = "${value}". Duplicate external identifiers are not allowed.`,
    );
    this.name = "DuplicateExternalIdError";
  }
}

export class PatientNotFoundError extends Error {
  constructor(patientId: string) {
    super(`Patient ${patientId} does not exist.`);
    this.name = "PatientNotFoundError";
  }
}

/** The edit was based on an older version of the patient (optimistic concurrency). */
export class PatientConflictError extends Error {
  readonly currentVersion: number;
  constructor(currentVersion: number) {
    super(
      "This patient was changed by someone else after you opened it. Reload the page to see the current details, then re-apply your change.",
    );
    this.name = "PatientConflictError";
    this.currentVersion = currentVersion;
  }
}

/** A Nationality / Preferred Language option id that is unknown, retired or from another list. */
export class InvalidDemographicOptionError extends Error {
  constructor(listCode: DemographicListCode) {
    super(`The selected ${DEMOGRAPHIC_LIST_NAMES[listCode]} is not an available option.`);
    this.name = "InvalidDemographicOptionError";
  }
}

export class DuplicateDemographicOptionError extends Error {
  constructor(label: string) {
    super(
      `An option "${label}" already exists in this list (it may be retired — ask an administrator to reactivate it).`,
    );
    this.name = "DuplicateDemographicOptionError";
  }
}

export class DemographicOptionNotFoundError extends Error {
  constructor(optionId: string) {
    super(`Option ${optionId} does not exist.`);
    this.name = "DemographicOptionNotFoundError";
  }
}

export interface DemographicOptionView {
  id: string;
  label: string;
  isActive: boolean;
}

export interface PatientRecord {
  id: string;
  firstName: string;
  lastName: string;
  middleName: string | null;
  dateOfBirth: string | null;
  sex: string | null;
  phone: string | null;
  email: string | null;
  nationalityOptionId: string | null;
  preferredLanguageOptionId: string | null;
  nationality: DemographicOptionView | null;
  preferredLanguage: DemographicOptionView | null;
  insuranceId: string | null;
  isActive: boolean;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  emergencyContactRelationship: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  externalIds: { system: string; value: string }[];
}

/** The value of one external identifier system on a patient, if any. */
export function externalIdOf(
  patient: Pick<PatientRecord, "externalIds">,
  system: ExternalIdSystem,
): string | null {
  return patient.externalIds.find((e) => e.system === system)?.value ?? null;
}

type PatientRow = typeof patients.$inferSelect;

function pgErrorField(err: unknown, field: "code" | "constraint"): unknown {
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

function isExternalIdUniqueViolation(err: unknown): boolean {
  return (
    pgErrorField(err, "code") === "23505" &&
    pgErrorField(err, "constraint") === "patient_external_ids_system_value_idx"
  );
}

/** External ids of many patients in ONE query (no N+1). */
async function loadExternalIdsFor(
  db: Tx,
  patientIds: string[],
): Promise<Map<string, { system: string; value: string }[]>> {
  const byPatient = new Map<string, { system: string; value: string }[]>();
  if (patientIds.length === 0) return byPatient;
  const rows = await db
    .select({
      patientId: patientExternalIds.patientId,
      system: patientExternalIds.system,
      value: patientExternalIds.value,
    })
    .from(patientExternalIds)
    .where(inArray(patientExternalIds.patientId, patientIds))
    .orderBy(asc(patientExternalIds.system));
  for (const r of rows) {
    const list = byPatient.get(r.patientId) ?? [];
    list.push({ system: r.system, value: r.value });
    byPatient.set(r.patientId, list);
  }
  return byPatient;
}

/** Option labels of many option ids in ONE query. */
async function loadOptionsById(
  db: Tx,
  optionIds: (string | null)[],
): Promise<Map<string, DemographicOptionView>> {
  const ids = [...new Set(optionIds.filter((v): v is string => v !== null))];
  const byId = new Map<string, DemographicOptionView>();
  if (ids.length === 0) return byId;
  const rows = await db
    .select({
      id: demographicOptions.id,
      label: demographicOptions.label,
      isActive: demographicOptions.isActive,
    })
    .from(demographicOptions)
    .where(inArray(demographicOptions.id, ids));
  for (const r of rows) byId.set(r.id, r);
  return byId;
}

async function toRecords(db: Tx, rows: PatientRow[]): Promise<PatientRecord[]> {
  const externalIds = await loadExternalIdsFor(
    db,
    rows.map((r) => r.id),
  );
  const options = await loadOptionsById(
    db,
    rows.flatMap((r) => [r.nationalityOptionId, r.preferredLanguageOptionId]),
  );
  return rows.map((row) => ({
    ...row,
    nationality: row.nationalityOptionId ? (options.get(row.nationalityOptionId) ?? null) : null,
    preferredLanguage: row.preferredLanguageOptionId
      ? (options.get(row.preferredLanguageOptionId) ?? null)
      : null,
    externalIds: externalIds.get(row.id) ?? [],
  }));
}

async function toRecord(db: Tx, row: PatientRow): Promise<PatientRecord> {
  const [record] = await toRecords(db, [row]);
  if (!record) throw new Error("Failed to load patient");
  return record;
}

/**
 * Checks a Nationality / Preferred Language option id. New selections must be an
 * ACTIVE option of the right list; a retired option is accepted only when it is
 * the value the patient already has (so saving an unrelated edit never fails
 * because an option was retired meanwhile).
 */
async function assertDemographicOption(
  tx: Tx,
  listCode: DemographicListCode,
  optionId: string | undefined,
  currentId: string | null,
): Promise<void> {
  if (!optionId) return;
  const [option] = await tx
    .select()
    .from(demographicOptions)
    .where(eq(demographicOptions.id, optionId))
    .limit(1);
  if (!option || option.listCode !== listCode) throw new InvalidDemographicOptionError(listCode);
  if (!option.isActive && option.id !== currentId) throw new InvalidDemographicOptionError(listCode);
}

async function assertExternalIdFree(
  tx: Tx,
  system: ExternalIdSystem,
  value: string,
  exceptPatientId: string | null,
): Promise<void> {
  const [dup] = await tx
    .select({ id: patientExternalIds.id })
    .from(patientExternalIds)
    .where(
      and(
        eq(patientExternalIds.system, system),
        eq(patientExternalIds.value, value),
        exceptPatientId ? ne(patientExternalIds.patientId, exceptPatientId) : undefined,
      ),
    )
    .limit(1);
  if (dup) throw new DuplicateExternalIdError(system, value);
}

/**
 * Sets (or clears, when `value` is undefined) the single value of `system` for
 * a patient. The unique (system, value) index is the race-safe backstop.
 */
async function setExternalId(
  tx: Tx,
  patientId: string,
  system: ExternalIdSystem,
  value: string | undefined,
): Promise<void> {
  const [existing] = await tx
    .select()
    .from(patientExternalIds)
    .where(and(eq(patientExternalIds.patientId, patientId), eq(patientExternalIds.system, system)))
    .limit(1);
  if (!value) {
    if (existing) await tx.delete(patientExternalIds).where(eq(patientExternalIds.id, existing.id));
    return;
  }
  if (existing?.value === value) return;
  await assertExternalIdFree(tx, system, value, patientId);
  if (existing) {
    await tx
      .update(patientExternalIds)
      .set({ value })
      .where(eq(patientExternalIds.id, existing.id));
  } else {
    await tx.insert(patientExternalIds).values({ patientId, system, value });
  }
}

/** Maps a unique-index race on external ids to the same clear error. */
async function withExternalIdRace<T>(
  input: { icareFileNo?: string; nationalId?: string },
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isExternalIdUniqueViolation(err)) {
      // We cannot tell from the error which system collided; report the File ID
      // first because it is the one users type most.
      if (input.icareFileNo) {
        throw new DuplicateExternalIdError(EXTERNAL_ID_SYSTEMS.ICARE_FILE_NO, input.icareFileNo);
      }
      if (input.nationalId) {
        throw new DuplicateExternalIdError(EXTERNAL_ID_SYSTEMS.NATIONAL_ID, input.nationalId);
      }
    }
    throw err;
  }
}

function demographicColumns(input: CreatePatientInput) {
  return {
    firstName: input.firstName,
    lastName: input.lastName,
    middleName: input.middleName ?? null,
    dateOfBirth: input.dateOfBirth ?? null,
    sex: input.sex ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    nationalityOptionId: input.nationalityOptionId ?? null,
    preferredLanguageOptionId: input.preferredLanguageOptionId ?? null,
    insuranceId: input.insuranceId ?? null,
    emergencyContactName: input.emergencyContactName ?? null,
    emergencyContactPhone: input.emergencyContactPhone ?? null,
    emergencyContactRelationship: input.emergencyContactRelationship ?? null,
  };
}

export async function createPatient(
  db: Database,
  actor: ActorContext,
  input: CreatePatientInput,
): Promise<PatientRecord> {
  await requirePermission(db, actor, PERMISSIONS.PATIENT_CREATE, {
    entityType: "patient",
  });

  return withExternalIdRace(input, () =>
    db.transaction(async (tx) => {
      if (input.icareFileNo) {
        await assertExternalIdFree(tx, EXTERNAL_ID_SYSTEMS.ICARE_FILE_NO, input.icareFileNo, null);
      }
      if (input.nationalId) {
        await assertExternalIdFree(tx, EXTERNAL_ID_SYSTEMS.NATIONAL_ID, input.nationalId, null);
      }
      await assertDemographicOption(tx, "nationality", input.nationalityOptionId, null);
      await assertDemographicOption(tx, "preferred_language", input.preferredLanguageOptionId, null);

      const [created] = await tx
        .insert(patients)
        .values({
          ...demographicColumns(input),
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning();
      if (!created) throw new Error("Failed to create patient");

      await setExternalId(tx, created.id, EXTERNAL_ID_SYSTEMS.ICARE_FILE_NO, input.icareFileNo);
      await setExternalId(tx, created.id, EXTERNAL_ID_SYSTEMS.NATIONAL_ID, input.nationalId);

      const record = await toRecord(tx, created);

      await writeAudit(tx, {
        actorUserId: actor.userId,
        action: "patient.create",
        entityType: "patient",
        entityId: created.id,
        patientId: created.id,
        after: record,
        metadata: { ip: actor.ip ?? null, userAgent: actor.userAgent ?? null },
      });

      return record;
    }),
  );
}

/**
 * Locks the patient row and checks the caller's expected version. Returns the
 * current row (the audit "before").
 */
async function lockForChange(
  tx: Tx,
  patientId: string,
  expectedVersion: number,
): Promise<PatientRow> {
  const [before] = await tx
    .select()
    .from(patients)
    .where(eq(patients.id, patientId))
    .limit(1)
    .for("update");
  if (!before) throw new PatientNotFoundError(patientId);
  if (before.version !== expectedVersion) throw new PatientConflictError(before.version);
  return before;
}

export async function updatePatient(
  db: Database,
  actor: ActorContext,
  input: UpdatePatientInput,
): Promise<PatientRecord> {
  await requirePermission(db, actor, PERMISSIONS.PATIENT_UPDATE, {
    entityType: "patient",
    entityId: input.id,
    patientId: input.id,
  });

  return withExternalIdRace(input, () =>
    db.transaction(async (tx) => {
      const beforeRow = await lockForChange(tx, input.id, input.expectedVersion);
      const before = await toRecord(tx, beforeRow);

      await assertDemographicOption(
        tx,
        "nationality",
        input.nationalityOptionId,
        beforeRow.nationalityOptionId,
      );
      await assertDemographicOption(
        tx,
        "preferred_language",
        input.preferredLanguageOptionId,
        beforeRow.preferredLanguageOptionId,
      );

      // is_active is deliberately NOT touched here: only setPatientActive
      // (patient.set_active, Admin) may change it.
      const [afterRow] = await tx
        .update(patients)
        .set({
          ...demographicColumns(input),
          version: beforeRow.version + 1,
          updatedBy: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(patients.id, input.id))
        .returning();
      if (!afterRow) throw new Error("Failed to update patient");

      await setExternalId(tx, input.id, EXTERNAL_ID_SYSTEMS.ICARE_FILE_NO, input.icareFileNo);
      await setExternalId(tx, input.id, EXTERNAL_ID_SYSTEMS.NATIONAL_ID, input.nationalId);

      const after = await toRecord(tx, afterRow);

      await writeAudit(tx, {
        actorUserId: actor.userId,
        action: "patient.update",
        entityType: "patient",
        entityId: input.id,
        patientId: input.id,
        before,
        after,
        metadata: { ip: actor.ip ?? null, userAgent: actor.userAgent ?? null },
      });

      return after;
    }),
  );
}

/**
 * Marks a patient inactive or reactivates them (Admin only, ADR-028). Inactive
 * patients are hidden from default search and cannot get new visits; nothing
 * else about them (history, visits, clinical data) changes.
 */
export async function setPatientActive(
  db: Database,
  actor: ActorContext,
  input: SetPatientActiveInput,
): Promise<PatientRecord> {
  await requirePermission(db, actor, PERMISSIONS.PATIENT_SET_ACTIVE, {
    entityType: "patient",
    entityId: input.id,
    patientId: input.id,
  });

  return db.transaction(async (tx) => {
    const beforeRow = await lockForChange(tx, input.id, input.expectedVersion);
    if (beforeRow.isActive === input.isActive) return toRecord(tx, beforeRow);

    const [afterRow] = await tx
      .update(patients)
      .set({
        isActive: input.isActive,
        version: beforeRow.version + 1,
        updatedBy: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(patients.id, input.id))
      .returning();
    if (!afterRow) throw new Error("Failed to update patient");

    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: input.isActive ? "patient.reactivate" : "patient.deactivate",
      entityType: "patient",
      entityId: input.id,
      patientId: input.id,
      before: { isActive: beforeRow.isActive, version: beforeRow.version },
      after: { isActive: afterRow.isActive, version: afterRow.version },
      metadata: { ip: actor.ip ?? null, userAgent: actor.userAgent ?? null },
    });

    return toRecord(tx, afterRow);
  });
}

export async function getPatientById(
  db: Database,
  actor: ActorContext,
  id: string,
): Promise<PatientRecord | null> {
  await requirePermissionRead(db, actor, id);

  const [patient] = await db
    .select()
    .from(patients)
    .where(eq(patients.id, id))
    .limit(1);
  if (!patient) return null;

  return toRecord(db, patient);
}

/**
 * Escapes LIKE metacharacters so user input matches literally: a typed `%`
 * or `_` must not act as a wildcard (e.g. file number "12_" must not match
 * "123"). Backslash is PostgreSQL's default LIKE escape character.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const contains = (value: string) => `%${escapeLike(value)}%`;
const startsWith = (value: string) => `${escapeLike(value)}%`;

export const SEARCH_RESULT_LIMIT = 100;

export async function searchPatients(
  db: Database,
  actor: ActorContext,
  criteria: SearchPatientsInput,
): Promise<PatientRecord[]> {
  await requirePermissionRead(db, actor);

  const conditions = [];

  if (criteria.name) {
    const nameCondition = or(
      ilike(patients.firstName, contains(criteria.name)),
      ilike(patients.lastName, contains(criteria.name)),
    );
    if (nameCondition) conditions.push(nameCondition);
  }
  if (criteria.firstName) {
    conditions.push(ilike(patients.firstName, contains(criteria.firstName)));
  }
  if (criteria.lastName) {
    conditions.push(ilike(patients.lastName, contains(criteria.lastName)));
  }
  if (criteria.phone) {
    conditions.push(ilike(patients.phone, contains(criteria.phone)));
  }
  if (criteria.insuranceId) {
    conditions.push(ilike(patients.insuranceId, startsWith(criteria.insuranceId)));
  }
  if (criteria.dateOfBirth) {
    conditions.push(eq(patients.dateOfBirth, criteria.dateOfBirth));
  }
  if (!criteria.includeInactive) {
    conditions.push(eq(patients.isActive, true));
  }

  if (criteria.externalId) {
    // File / Medical ID = the iCare file number (prefix). Filter in SQL (before
    // ORDER BY / LIMIT) so a matching file number is never dropped because its
    // patient falls outside the first page.
    const ext = alias(patientExternalIds, "search_ext");
    conditions.push(
      inArray(
        patients.id,
        db
          .select({ patientId: ext.patientId })
          .from(ext)
          .where(
            and(
              eq(ext.system, EXTERNAL_ID_SYSTEMS.ICARE_FILE_NO),
              ilike(ext.value, startsWith(criteria.externalId)),
            ),
          ),
      ),
    );
  }

  const rows = await db
    .select()
    .from(patients)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(patients.lastName, patients.firstName)
    .limit(SEARCH_RESULT_LIMIT);

  return toRecords(db, rows);
}

async function requirePermissionRead(
  db: Database,
  actor: ActorContext,
  patientId?: string,
): Promise<void> {
  await requirePermission(db, actor, PERMISSIONS.PATIENT_READ, {
    entityType: "patient",
    entityId: patientId,
    patientId: patientId ?? null,
  });
}

// --- Demographic option lists (Nationality / Preferred Language, ADR-028) ---

/** Active options of every demographic list, for the patient form. */
export async function listDemographicOptions(
  db: Database,
  actor: ActorContext,
): Promise<Record<DemographicListCode, DemographicOptionView[]>> {
  await requirePermissionRead(db, actor);
  const rows = await db
    .select()
    .from(demographicOptions)
    .orderBy(asc(demographicOptions.sortOrder), asc(demographicOptions.label));
  const result: Record<DemographicListCode, DemographicOptionView[]> = {
    nationality: [],
    preferred_language: [],
  };
  for (const r of rows) {
    const list = result[r.listCode as DemographicListCode];
    if (list) list.push({ id: r.id, label: r.label, isActive: r.isActive });
  }
  return result;
}

/** "+ Add New" for a demographic list. Audited. */
export async function addDemographicOption(
  db: Database,
  actor: ActorContext,
  input: AddDemographicOptionInput,
): Promise<DemographicOptionView> {
  await requirePermission(db, actor, PERMISSIONS.PATIENT_OPTION_ADD, {
    entityType: "demographic_option",
    entityId: input.listCode,
  });

  const label = input.label.trim();
  try {
    return await db.transaction(async (tx) => {
      const [duplicate] = await tx
        .select({ id: demographicOptions.id })
        .from(demographicOptions)
        .where(
          and(
            eq(demographicOptions.listCode, input.listCode),
            sql`lower(${demographicOptions.label}) = lower(${label})`,
          ),
        )
        .limit(1);
      if (duplicate) throw new DuplicateDemographicOptionError(label);

      const [max] = await tx
        .select({ value: sql<number>`coalesce(max(${demographicOptions.sortOrder}), 0)` })
        .from(demographicOptions)
        .where(eq(demographicOptions.listCode, input.listCode));

      const [created] = await tx
        .insert(demographicOptions)
        .values({
          listCode: input.listCode,
          label,
          sortOrder: Number(max?.value ?? 0) + 1,
          createdBy: actor.userId,
        })
        .returning();
      if (!created) throw new Error("Failed to create option");

      await writeAudit(tx, {
        actorUserId: actor.userId,
        action: "demographic_option.create",
        entityType: "demographic_option",
        entityId: created.id,
        after: created,
        metadata: { ip: actor.ip ?? null, userAgent: actor.userAgent ?? null },
      });

      return { id: created.id, label: created.label, isActive: created.isActive };
    });
  } catch (err) {
    if (pgErrorField(err, "code") === "23505") throw new DuplicateDemographicOptionError(label);
    throw err;
  }
}

/** Retires or reactivates a demographic option (never renamed or deleted). Audited. */
export async function setDemographicOptionActive(
  db: Database,
  actor: ActorContext,
  input: SetDemographicOptionActiveInput,
): Promise<void> {
  await requirePermission(db, actor, PERMISSIONS.PATIENT_OPTION_MANAGE, {
    entityType: "demographic_option",
    entityId: input.optionId,
  });

  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(demographicOptions)
      .where(eq(demographicOptions.id, input.optionId))
      .limit(1)
      .for("update");
    if (!before) throw new DemographicOptionNotFoundError(input.optionId);
    if (before.isActive === input.isActive) return;

    const [after] = await tx
      .update(demographicOptions)
      .set({ isActive: input.isActive })
      .where(eq(demographicOptions.id, input.optionId))
      .returning();
    if (!after) throw new Error("Failed to update option");

    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "demographic_option.update",
      entityType: "demographic_option",
      entityId: after.id,
      before,
      after,
      metadata: { ip: actor.ip ?? null, userAgent: actor.userAgent ?? null },
    });
  });
}
