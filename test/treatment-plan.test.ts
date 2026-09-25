import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditLogs,
  clinicalEntries,
  clinicalFieldDefinitions,
  treatmentPlanEntries,
  treatmentPlanItems,
  visits,
} from "@/db/schema";
import { handleGetClinicalSection, handleSaveTreatmentPlanCell, type ApiDeps } from "@/modules/clinical/api";
import {
  TREATMENT_PLAN_COLUMN_CODES,
  TREATMENT_PLAN_MIN_ROWS,
  TREATMENT_PLAN_SECTION_CODE,
} from "@/modules/clinical/definitions";
import {
  addClinicalOption,
  ClinicalConflictError,
  ClinicalFieldNotFoundError,
  InvalidClinicalValueError,
  listClinicalSections,
  MutationIdReuseError,
  saveClinicalEntry,
  VisitNotOpenError,
} from "@/modules/clinical/service";
import {
  getTreatmentPlanForVisit,
  saveTreatmentPlanCell,
  treatmentCellCode,
  TreatmentPlanItemNotFoundError,
  type TreatmentPlanView,
} from "@/modules/clinical/treatment-plan";
import { createPatient } from "@/modules/patients/service";
import { ForbiddenError } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import { createVisit } from "@/modules/visits/service";
import { createTestUser, openTestDb, uniqueSuffix } from "./helpers";

describe("Treatment Plan (R2, ADR-030)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let doctor: ActorContext;
  const col: Record<string, string> = {};

  beforeAll(async () => {
    const opened = openTestDb();
    db = opened.db;
    close = opened.close;
    doctor = (await createTestUser(db, { roleCode: "DOCTOR" })).actor;
    const rows = await db
      .select({ id: clinicalFieldDefinitions.id, code: clinicalFieldDefinitions.code })
      .from(clinicalFieldDefinitions);
    for (const r of rows) col[r.code] = r.id;
  });

  afterAll(async () => {
    await close();
  });

  async function newPatientVisit(actor: ActorContext = doctor) {
    const s = uniqueSuffix();
    const patient = await createPatient(db, actor, {
      firstName: `Tp-${s}`,
      lastName: `Plan-${s}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });
    const visit = await createVisit(db, actor, { patientId: patient.id, reason: undefined });
    return { patientId: patient.id, visitId: visit.id };
  }

  function cell(
    visitId: string,
    itemId: string,
    code: string,
    value: { optionIds?: string[]; freeText?: string; checked?: boolean },
    expectedVersion = 0,
    clientMutationId = randomUUID(),
  ) {
    return {
      visitId,
      itemId,
      fieldId: col[code] ?? "",
      optionIds: value.optionIds ?? [],
      freeText: value.freeText ?? "",
      ...(value.checked === undefined ? {} : { checked: value.checked }),
      expectedVersion,
      clientMutationId,
    };
  }

  const cellOf = (plan: TreatmentPlanView, code: string, row: number) =>
    plan.fields.find((f) => f.code === treatmentCellCode(code, row));

  /** The trigger's message is on the driver error, wrapped by drizzle. */
  async function expectAppendOnly(query: Promise<unknown>) {
    const err = await query.then(
      () => null,
      (e: unknown) => e,
    );
    const cause = err instanceof Error ? (err.cause ?? err) : null;
    expect(cause instanceof Error ? cause.message : String(err)).toMatch(/is append-only/);
  }

  it("defines its columns as fields placed in no tab, and a Treatment Plan tab after Assessment Plan+", async () => {
    for (const code of TREATMENT_PLAN_COLUMN_CODES) expect(col[code], code).toBeDefined();
    const tabs = await listClinicalSections(db, doctor);
    const codes = tabs.map((t) => t.code);
    expect(codes.indexOf(TREATMENT_PLAN_SECTION_CODE)).toBe(codes.indexOf("assessment_plan") + 1);
  });

  it("an empty plan shows SonoSoft's 25 empty rows, 5 cells each, with fresh row ids", async () => {
    const { visitId } = await newPatientVisit();
    const plan = await getTreatmentPlanForVisit(db, doctor, visitId);
    expect(plan.rows).toHaveLength(TREATMENT_PLAN_MIN_ROWS);
    expect(plan.rows.every((r) => r.position === null)).toBe(true);
    expect(plan.fields).toHaveLength(TREATMENT_PLAN_MIN_ROWS * TREATMENT_PLAN_COLUMN_CODES.length);
    expect(cellOf(plan, "treatment_procedure", 1)?.version).toBe(0);
    const again = await getTreatmentPlanForVisit(db, doctor, visitId);
    expect(again.rows[0]?.itemId).not.toBe(plan.rows[0]?.itemId);
    expect(await db.select().from(treatmentPlanItems).where(eq(treatmentPlanItems.createdInVisitId, visitId))).toHaveLength(0);
  });

  it("the first non-empty save creates the row at the end of the plan; an empty save creates nothing", async () => {
    const { patientId, visitId } = await newPatientVisit();
    const a = randomUUID();
    const b = randomUUID();

    const noop = await saveTreatmentPlanCell(db, doctor, cell(visitId, a, "treatment_procedure", { freeText: "  " }));
    expect(noop).toMatchObject({ changed: false, createdItem: false, version: 0 });
    expect(await db.select().from(treatmentPlanItems).where(eq(treatmentPlanItems.patientId, patientId))).toHaveLength(0);

    // Row b typed first: it is row 1.
    const first = await saveTreatmentPlanCell(db, doctor, cell(visitId, b, "treatment_procedure", { freeText: "Sclerotherapy" }));
    expect(first).toMatchObject({ changed: true, createdItem: true, version: 1 });
    await saveTreatmentPlanCell(db, doctor, cell(visitId, a, "treatment_scheduled", { freeText: "2026-02-02" }));
    const second = await saveTreatmentPlanCell(db, doctor, cell(visitId, b, "treatment_status", { freeText: "approved" }));
    expect(second.createdItem).toBe(false);

    const items = await db
      .select()
      .from(treatmentPlanItems)
      .where(eq(treatmentPlanItems.patientId, patientId))
      .orderBy(asc(treatmentPlanItems.position));
    expect(items.map((i) => [i.id, i.position, i.createdInVisitId])).toEqual([
      [b, 1, visitId],
      [a, 2, visitId],
    ]);

    const plan = await getTreatmentPlanForVisit(db, doctor, visitId);
    expect(plan.rows.slice(0, 2)).toEqual([
      { itemId: b, position: 1 },
      { itemId: a, position: 2 },
    ]);
    expect(cellOf(plan, "treatment_procedure", 1)?.value).toEqual({ optionIds: [], freeText: "Sclerotherapy" });
    expect(cellOf(plan, "treatment_scheduled", 2)?.value).toEqual({ optionIds: [], freeText: "2026-02-02" });
  });

  it("is one plan per patient: every visit of the patient shows it, other patients never do", async () => {
    const { patientId, visitId } = await newPatientVisit();
    const later = await createVisit(db, doctor, { patientId, reason: undefined });
    const other = await newPatientVisit();
    const row = randomUUID();
    await saveTreatmentPlanCell(db, doctor, cell(visitId, row, "treatment_procedure", { freeText: "EVLA left GSV" }));

    // Completed from the later visit: same row, next version of that cell.
    await saveTreatmentPlanCell(db, doctor, cell(later.id, row, "treatment_completed", { freeText: "2026-03-01" }));
    const fromLater = await getTreatmentPlanForVisit(db, doctor, later.id);
    expect(fromLater.rows[0]).toEqual({ itemId: row, position: 1 });
    expect(cellOf(fromLater, "treatment_completed", 1)?.value.freeText).toBe("2026-03-01");

    const fromOther = await getTreatmentPlanForVisit(db, doctor, other.visitId);
    expect(fromOther.rows.every((r) => r.position === null)).toBe(true);
    // Writing to another patient's row through one's own visit is refused as not found.
    await expect(
      saveTreatmentPlanCell(db, doctor, cell(other.visitId, row, "treatment_status", { freeText: "x" })),
    ).rejects.toBeInstanceOf(TreatmentPlanItemNotFoundError);
  });

  it("each cell keeps an append-only history with the visit it was changed from", async () => {
    const { visitId } = await newPatientVisit();
    const row = randomUUID();
    await saveTreatmentPlanCell(db, doctor, cell(visitId, row, "treatment_status", { freeText: "pending" }));
    await saveTreatmentPlanCell(db, doctor, cell(visitId, row, "treatment_status", { freeText: "approved" }, 1));
    const history = await db
      .select()
      .from(treatmentPlanEntries)
      .where(and(eq(treatmentPlanEntries.itemId, row), eq(treatmentPlanEntries.fieldDefinitionId, col.treatment_status ?? "")))
      .orderBy(asc(treatmentPlanEntries.version));
    expect(history.map((h) => [h.version, h.value.freeText, h.visitId])).toEqual([
      [1, "pending", visitId],
      [2, "approved", visitId],
    ]);

    await expectAppendOnly(db.execute(sql`UPDATE treatment_plan_entries SET version = 9 WHERE item_id = ${row}`));
    await expectAppendOnly(db.execute(sql`DELETE FROM treatment_plan_entries WHERE item_id = ${row}`));
    await expectAppendOnly(db.execute(sql`UPDATE treatment_plan_items SET position = 99 WHERE id = ${row}`));
    await expectAppendOnly(db.execute(sql`DELETE FROM treatment_plan_items WHERE id = ${row}`));
  });

  it("a stale cell is a conflict and writes nothing; other cells of the row are independent", async () => {
    const { visitId } = await newPatientVisit();
    const row = randomUUID();
    await saveTreatmentPlanCell(db, doctor, cell(visitId, row, "treatment_procedure", { freeText: "one" }));
    const err = await saveTreatmentPlanCell(db, doctor, cell(visitId, row, "treatment_procedure", { freeText: "two" }, 0)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ClinicalConflictError);
    expect((err as ClinicalConflictError).current).toMatchObject({ version: 1, value: { freeText: "one" } });
    // A different column of the same row starts at version 0.
    await expect(
      saveTreatmentPlanCell(db, doctor, cell(visitId, row, "treatment_status", { freeText: "ok" }, 0)),
    ).resolves.toMatchObject({ version: 1 });
  });

  it("replays a mutation id, and refuses its reuse for anything else", async () => {
    const { visitId } = await newPatientVisit();
    const row = randomUUID();
    const id = randomUUID();
    const input = cell(visitId, row, "treatment_procedure", { freeText: "Foam" }, 0, id);
    await saveTreatmentPlanCell(db, doctor, input);
    await expect(saveTreatmentPlanCell(db, doctor, input)).resolves.toMatchObject({ replayed: true, version: 1 });
    await expect(
      saveTreatmentPlanCell(db, doctor, { ...input, freeText: "Other" }),
    ).rejects.toBeInstanceOf(MutationIdReuseError);
    await expect(
      saveTreatmentPlanCell(db, doctor, { ...input, itemId: randomUUID() }),
    ).rejects.toBeInstanceOf(MutationIdReuseError);
  });

  it("validates dates, options of the column's own list, and the checkbox", async () => {
    const { visitId } = await newPatientVisit();
    const row = randomUUID();
    for (const bad of ["31/02/2026", "2026-02-30", "2026-2-1", "1850-01-01", "tomorrow"]) {
      await expect(
        saveTreatmentPlanCell(db, doctor, cell(visitId, row, "treatment_scheduled", { freeText: bad })),
        bad,
      ).rejects.toBeInstanceOf(InvalidClinicalValueError);
    }
    const s = uniqueSuffix();
    const procedure = await addClinicalOption(db, doctor, { fieldId: col.treatment_procedure ?? "", label: `EVLA ${s}` });
    const status = await addClinicalOption(db, doctor, { fieldId: col.treatment_status ?? "", label: `Approved ${s}` });
    await expect(
      saveTreatmentPlanCell(db, doctor, cell(visitId, row, "treatment_procedure", { optionIds: [status.id] })),
    ).rejects.toBeInstanceOf(InvalidClinicalValueError);
    await expect(
      saveTreatmentPlanCell(db, doctor, cell(visitId, row, "treatment_procedure", { optionIds: [procedure.id], freeText: "left" })),
    ).resolves.toMatchObject({ value: { optionIds: [procedure.id], freeText: "left" } });
    await expect(
      saveTreatmentPlanCell(db, doctor, cell(visitId, row, "treatment_cancelled", { freeText: "yes" })),
    ).rejects.toBeInstanceOf(InvalidClinicalValueError);
  });

  it("cancelling marks the row and keeps it, in place, with its history", async () => {
    const { visitId } = await newPatientVisit();
    const row = randomUUID();
    await saveTreatmentPlanCell(db, doctor, cell(visitId, row, "treatment_procedure", { freeText: "Wrong row" }));
    await saveTreatmentPlanCell(db, doctor, cell(visitId, row, "treatment_cancelled", { checked: true }));
    const plan = await getTreatmentPlanForVisit(db, doctor, visitId);
    expect(plan.rows[0]).toEqual({ itemId: row, position: 1 });
    expect(cellOf(plan, "treatment_cancelled", 1)?.value).toEqual({ optionIds: [], freeText: "", checked: true });
    expect(cellOf(plan, "treatment_procedure", 1)?.value.freeText).toBe("Wrong row");
  });

  it("refuses a closed visit, a non-column field, and column fields as visit entries", async () => {
    const { visitId } = await newPatientVisit();
    await expect(
      saveTreatmentPlanCell(db, doctor, { ...cell(visitId, randomUUID(), "treatment_status", {}), fieldId: col.comments ?? "", freeText: "x" }),
    ).rejects.toBeInstanceOf(ClinicalFieldNotFoundError);
    await expect(
      saveClinicalEntry(db, doctor, {
        visitId,
        fieldId: col.treatment_procedure ?? "",
        optionIds: [],
        freeText: "x",
        expectedVersion: 0,
        clientMutationId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ClinicalFieldNotFoundError);
    expect(await db.select().from(clinicalEntries).where(eq(clinicalEntries.visitId, visitId))).toHaveLength(0);

    await db.update(visits).set({ status: "closed" }).where(eq(visits.id, visitId));
    await expect(
      saveTreatmentPlanCell(db, doctor, cell(visitId, randomUUID(), "treatment_status", { freeText: "late" })),
    ).rejects.toBeInstanceOf(VisitNotOpenError);
  });

  it("permissions: nurse writes, admin reads only, reception has no access", async () => {
    const { visitId } = await newPatientVisit();
    const nurse = (await createTestUser(db, { roleCode: "NURSE_ASSISTANT" })).actor;
    const admin = (await createTestUser(db, { roleCode: "ADMIN" })).actor;
    const reception = (await createTestUser(db, { roleCode: "RECEPTION" })).actor;
    const row = randomUUID();
    await expect(
      saveTreatmentPlanCell(db, nurse, cell(visitId, row, "treatment_procedure", { freeText: "nurse" })),
    ).resolves.toMatchObject({ changed: true });
    await expect(getTreatmentPlanForVisit(db, admin, visitId)).resolves.toBeDefined();
    await expect(
      saveTreatmentPlanCell(db, admin, cell(visitId, row, "treatment_status", { freeText: "admin" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getTreatmentPlanForVisit(db, reception, visitId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      saveTreatmentPlanCell(db, reception, cell(visitId, randomUUID(), "treatment_status", { freeText: "r" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("audits row creation and every cell change with patient and visit", async () => {
    const { patientId, visitId } = await newPatientVisit();
    const row = randomUUID();
    await saveTreatmentPlanCell(db, doctor, cell(visitId, row, "treatment_procedure", { freeText: "a" }));
    await saveTreatmentPlanCell(db, doctor, cell(visitId, row, "treatment_procedure", { freeText: "b" }, 1));
    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.patientId, patientId))
      .orderBy(asc(auditLogs.id));
    const plan = audits.filter((a) => a.entityType.startsWith("treatment_plan"));
    expect(plan.map((a) => a.action)).toEqual([
      "treatment_plan_item.create",
      "treatment_plan_entry.create",
      "treatment_plan_entry.update",
    ]);
    expect(plan.every((a) => a.visitId === visitId && a.actorUserId === doctor.userId)).toBe(true);
    expect(plan[2]?.before).toMatchObject({ version: 1, value: { freeText: "a" } });
  });

  describe("Route Handlers", () => {
    const ORIGIN = "http://localhost:3000";
    const deps = (actor: ActorContext | null): ApiDeps => ({
      db,
      resolveActor: async () => actor,
      appOrigin: null,
      allowRequestOrigin: true,
    });

    it("saves a cell and returns the plan's cells as the tab's fields", async () => {
      const { visitId } = await newPatientVisit();
      const row = randomUUID();
      const res = await handleSaveTreatmentPlanCell(
        new Request(`${ORIGIN}/api/visits/${visitId}/treatment-plan/${row}/${col.treatment_procedure}`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({
            expectedUserId: doctor.userId,
            expectedVersion: 0,
            clientMutationId: randomUUID(),
            optionIds: [],
            freeText: "API row",
          }),
        }),
        { visitId, itemId: row, fieldId: col.treatment_procedure ?? "" },
        deps(doctor),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, version: 1, value: { freeText: "API row" } });

      const get = await handleGetClinicalSection(
        new Request(`${ORIGIN}/api/visits/${visitId}/clinical-sections/${TREATMENT_PLAN_SECTION_CODE}`),
        { visitId, sectionCode: TREATMENT_PLAN_SECTION_CODE },
        deps(doctor),
      );
      const body = (await get.json()) as { fields: { id: string; version: number; value: { freeText: string } }[] };
      expect(body.fields.find((f) => f.id === `${row}:${col.treatment_procedure}`)).toMatchObject({
        version: 1,
        value: { freeText: "API row" },
      });
    });

    it("maps another patient's row to 404, a bad id to 400, a stale version to 409 and a wrong user to 403", async () => {
      const mine = await newPatientVisit();
      const theirs = await newPatientVisit();
      const row = randomUUID();
      await saveTreatmentPlanCell(db, doctor, cell(theirs.visitId, row, "treatment_procedure", { freeText: "t" }));
      const call = (visitId: string, itemId: string, body: Record<string, unknown>) =>
        handleSaveTreatmentPlanCell(
          new Request(`${ORIGIN}/x`, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/json" },
            body: JSON.stringify({
              expectedUserId: doctor.userId,
              expectedVersion: 0,
              clientMutationId: randomUUID(),
              optionIds: [],
              freeText: "x",
              ...body,
            }),
          }),
          { visitId, itemId, fieldId: col.treatment_status ?? "" },
          deps(doctor),
        );
      expect((await call(mine.visitId, row, {})).status).toBe(404);
      expect((await call(mine.visitId, "not-a-uuid", {})).status).toBe(400);
      await saveTreatmentPlanCell(db, doctor, cell(theirs.visitId, row, "treatment_status", { freeText: "s" }));
      expect((await call(theirs.visitId, row, {})).status).toBe(409);
      expect((await call(theirs.visitId, row, { expectedUserId: randomUUID() })).status).toBe(403);
    });
  });
});
