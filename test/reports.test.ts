import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { clinicalFieldDefinitions, patients } from "@/db/schema";
import { LocalFileStorage } from "@/lib/file-storage";
import { saveClinicalEntry } from "@/modules/clinical/service";
import { saveDiagramVersion, readPatientFile } from "@/modules/diagrams/service";
import { composeHistory, composePastMedicalHistory, composeSections } from "@/modules/reports/compose";
import {
  getReportEditorData,
  InvalidReportError,
  listReportsForVisit,
  ReportConflictError,
  saveReportVersion,
} from "@/modules/reports/service";
import { createPatient } from "@/modules/patients/service";
import { ForbiddenError } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import { createVisit } from "@/modules/visits/service";
import { createTestUser, openTestDb, uniqueSuffix } from "./helpers";

const TZ = "Asia/Riyadh";
const PNG = new Uint8Array(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
));
const STROKES = [{ color: "#d11a2a", width: 4, erase: false, points: [1, 1, 5, 5] }];

describe("report composer (no broken sentences)", () => {
  const base = { patient: { firstName: "Sara", lastName: "Ali", sex: "F" as const, age: 40 }, proceduresToday: [] };
  it("uses only recorded values, with spaces and punctuation", () => {
    expect(composeHistory({ ...base, values: {} })).toBe("Sara Ali is a 40-year-old female.");
    expect(
      composeHistory({
        ...base,
        values: {
          chief_complaints: { text: "left leg varicose veins", checked: false },
          duration: { text: "for many years", checked: false },
          current_meds_none: { text: "", checked: true },
        },
      }),
    ).toBe(
      "Sara Ali is a 40-year-old female and complains of left leg varicose veins, for many years. The patient takes no medications.",
    );
    expect(composePastMedicalHistory({ ...base, values: { allergies_no_known: { text: "", checked: true } } })).toBe(
      "no known allergy",
    );
    const s = composeSections({ ...base, values: { impression_2: { text: "CVD C1", checked: false } } });
    expect(s.impression).toBe("CVD C1");
    expect(s.recommendations).toBe("");
    expect(s.physical_examination).toBe("");
  });
});

describe("reports (R5, ADR-034)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let doctor: ActorContext;
  let nurse: ActorContext;
  let dir: string;
  let storage: LocalFileStorage;

  beforeAll(async () => {
    ({ db, close } = openTestDb());
    doctor = (await createTestUser(db, { roleCode: "DOCTOR" })).actor;
    nurse = (await createTestUser(db, { roleCode: "NURSE_ASSISTANT" })).actor;
    dir = mkdtempSync(path.join(os.tmpdir(), "dawali-reports-"));
    storage = new LocalFileStorage(dir);
  });
  afterAll(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    const s = uniqueSuffix();
    const p = await createPatient(db, doctor, {
      firstName: `Rep${s}`,
      lastName: "Patient",
      middleName: undefined,
      dateOfBirth: "1986-01-01",
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: `RPT-${s}`,
    });
    await db.update(patients).set({ sex: "F" }).where(eq(patients.id, p.id));
    const visitId = (await createVisit(db, doctor, { patientId: p.id, reason: undefined })).id;
    const [field] = await db.select().from(clinicalFieldDefinitions).where(eq(clinicalFieldDefinitions.code, "impression_1"));
    await saveClinicalEntry(db, doctor, {
      visitId,
      fieldId: field!.id,
      optionIds: [],
      freeText: "CVD C1",
      expectedVersion: 0,
      clientMutationId: randomUUID(),
    });
    return { visitId, patientName: `Rep${s} Patient`, fileNo: `RPT-${s}` };
  }
  const diagram = (visitId: string, type: "leg" | "vein") =>
    saveDiagramVersion(
      db,
      storage,
      doctor,
      { visitId, diagramId: randomUUID(), diagramType: type, expectedVersion: 0, clientMutationId: randomUUID(), strokes: STROKES, png: PNG },
      TZ,
    );

  it("composes a first draft from the chart and defaults to the latest diagrams", async () => {
    const { visitId, fileNo } = await setup();
    const leg = await diagram(visitId, "leg");
    const data = await getReportEditorData(db, doctor, { visitId, reportId: randomUUID(), templateCode: "venous_evaluation" }, TZ);
    expect(data.exists).toBe(false);
    expect(data.fileNumber).toBe(fileNo);
    expect(data.content.sections.history).toMatch(/is a \d+-year-old female\.$/);
    expect(data.content.sections.impression).toBe("CVD C1");
    expect(data.content.diagramFileIds).toEqual({ leg: leg.fileId, vein: null });
  });

  it("draft -> final (.docx with data and diagrams) -> amended; finalized versions are kept", async () => {
    const { visitId, patientName, fileNo } = await setup();
    const reportId = randomUUID();
    const leg = await diagram(visitId, "leg");
    const vein = await diagram(visitId, "vein");
    const content = {
      sections: { history: "History text.", impression: "CVD C1\nC2", recommendations: "Sclerotherapy", ultrasound_findings: "" },
      diagramFileIds: { leg: leg.fileId, vein: vein.fileId },
    };
    const input = (over: Partial<Parameters<typeof saveReportVersion>[3]> = {}) => ({
      visitId,
      reportId,
      templateCode: "venous_evaluation",
      expectedVersion: 0,
      clientMutationId: randomUUID(),
      action: "draft" as const,
      content,
      ...over,
    });

    await expect(saveReportVersion(db, storage, doctor, input(), TZ)).resolves.toMatchObject({ version: 1, status: "draft", fileId: null });
    await expect(saveReportVersion(db, storage, doctor, input(), TZ)).rejects.toBeInstanceOf(ReportConflictError);
    await expect(saveReportVersion(db, storage, nurse, input({ expectedVersion: 1, action: "finalize" }), TZ)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const final = await saveReportVersion(db, storage, doctor, input({ expectedVersion: 1, action: "finalize" }), TZ);
    expect(final).toMatchObject({ version: 2, status: "final" });
    expect(final.fileName).toMatch(/_Report_Template2_v02\.docx$/);

    const file = await readPatientFile(db, storage, doctor, final.fileId!);
    const zip = await JSZip.loadAsync(file.bytes);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain(patientName);
    expect(xml).toContain(fileNo);
    expect(xml).toContain("HISTORY:");
    expect(xml).toContain("CVD C1");
    expect(xml).not.toContain("ULTRASOUND FINDINGS:"); // empty section left out
    expect(Object.keys(zip.files).filter((f) => f.startsWith("word/media/"))).toHaveLength(2);

    await expect(saveReportVersion(db, storage, doctor, input({ expectedVersion: 2 }), TZ)).rejects.toBeInstanceOf(InvalidReportError);
    const amended = await saveReportVersion(db, storage, doctor, input({ expectedVersion: 2, action: "finalize" }), TZ);
    expect(amended).toMatchObject({ version: 3, status: "amended" });
    expect(amended.fileId).not.toBe(final.fileId);

    const list = await listReportsForVisit(db, doctor, visitId);
    expect(list[0]?.versions.map((v) => v.status)).toEqual(["amended", "final", "draft"]);
    const err = await db.execute(sql`UPDATE report_versions SET status = 'draft' WHERE report_id = ${reportId}`).then(() => null, (e: unknown) => e);
    expect(err instanceof Error ? String(err.cause ?? err) : "").toMatch(/append-only/);
  });

  it("cannot finalize without the template's diagrams, nor with another visit's diagram", async () => {
    const a = await setup();
    const b = await setup();
    const foreign = await diagram(b.visitId, "leg");
    const base = {
      visitId: a.visitId,
      reportId: randomUUID(),
      templateCode: "short_procedure",
      expectedVersion: 0,
      action: "finalize" as const,
    };
    await expect(
      saveReportVersion(db, storage, doctor, { ...base, clientMutationId: randomUUID(), content: { sections: { narrative: "x" }, diagramFileIds: { leg: null } } }, TZ),
    ).rejects.toThrow(/needs a Leg Diagram/);
    await expect(
      saveReportVersion(db, storage, doctor, { ...base, clientMutationId: randomUUID(), content: { sections: { narrative: "x" }, diagramFileIds: { leg: foreign.fileId } } }, TZ),
    ).rejects.toThrow(/not a saved diagram of this visit/);
  });
});
