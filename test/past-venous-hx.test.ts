import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { clinicalFieldDefinitions } from "@/db/schema";
import {
  CLINICAL_SECTIONS,
  PAST_VENOUS_HX_FIELD_CODES,
  PAST_VENOUS_HX_SECTION_CODE,
} from "@/modules/clinical/definitions";
import { layoutFieldCodes, SECTION_LAYOUTS } from "@/modules/clinical/layouts";
import {
  addClinicalOption,
  getClinicalSectionForVisit,
  listClinicalSections,
  saveClinicalEntry,
} from "@/modules/clinical/service";
import { createPatient } from "@/modules/patients/service";
import type { ActorContext } from "@/modules/permissions/types";
import { createVisit } from "@/modules/visits/service";
import { createTestUser, openTestDb, uniqueSuffix } from "./helpers";

describe("Past Venous Hx tab (ADR-040)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let doctor: ActorContext;

  beforeAll(async () => {
    ({ db, close } = openTestDb());
    doctor = (await createTestUser(db, { roleCode: "DOCTOR" })).actor;
  });
  afterAll(async () => close());

  async function visitId() {
    const s = uniqueSuffix();
    const p = await createPatient(db, doctor, {
      firstName: `PVH-${s}`,
      lastName: `Tab-${s}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });
    return (await createVisit(db, doctor, { patientId: p.id, reason: undefined })).id;
  }

  async function fieldId(code: string) {
    const [row] = await db.select().from(clinicalFieldDefinitions).where(eq(clinicalFieldDefinitions.code, code));
    return row!.id;
  }

  it("is SonoSoft's second Workup tab: after Subj Complaints Habits, before Past Medical Hx", async () => {
    const order = CLINICAL_SECTIONS.map((s) => s.code);
    expect(order.slice(0, 3)).toEqual(["subj_complaints_habits", PAST_VENOUS_HX_SECTION_CODE, "past_medical_hx"]);
    expect(new Set(CLINICAL_SECTIONS.map((s) => s.sortOrder)).size).toBe(CLINICAL_SECTIONS.length);

    const ours = ["subj_complaints_habits", PAST_VENOUS_HX_SECTION_CODE, "past_medical_hx", "assessment_plan"];
    const live = (await listClinicalSections(db, doctor)).map((t) => t.code).filter((c) => ours.includes(c));
    expect(live).toEqual(ours);
  });

  it("places the twelve Venous History checkboxes and the narrative, each on the SonoSoft layout", async () => {
    const view = await getClinicalSectionForVisit(db, doctor, await visitId(), PAST_VENOUS_HX_SECTION_CODE);
    expect(view.fields.map((f) => f.code)).toEqual(PAST_VENOUS_HX_FIELD_CODES);
    expect(view.fields.filter((f) => f.fieldType === "checkbox")).toHaveLength(12);
    expect(view.fields.at(-1)).toMatchObject({ code: "vein_history_narrative", fieldType: "multiselect" });
    const layout = SECTION_LAYOUTS[PAST_VENOUS_HX_SECTION_CODE];
    expect(layout).toBeDefined();
    expect(layoutFieldCodes(layout!)).toEqual(PAST_VENOUS_HX_FIELD_CODES);
  });

  it("saves a checkbox and narrative sentences like any clinical entry", async () => {
    const visit = await visitId();
    const dvt = await saveClinicalEntry(db, doctor, {
      visitId: visit,
      fieldId: await fieldId("venous_hx_dvt"),
      optionIds: [],
      freeText: "",
      checked: true,
      expectedVersion: 0,
      clientMutationId: randomUUID(),
    });
    expect(dvt.entry?.value.checked).toBe(true);

    const narrativeId = await fieldId("vein_history_narrative");
    const sentence = await addClinicalOption(db, doctor, {
      fieldId: narrativeId,
      label: `The patient has no known history of DVT ${uniqueSuffix()}.`,
    });
    const saved = await saveClinicalEntry(db, doctor, {
      visitId: visit,
      fieldId: narrativeId,
      optionIds: [sentence.id],
      freeText: "Mother had varicose veins.",
      expectedVersion: 0,
      clientMutationId: randomUUID(),
    });
    expect(saved.entry?.value).toMatchObject({ optionIds: [sentence.id], freeText: "Mother had varicose veins." });

    const view = await getClinicalSectionForVisit(db, doctor, visit, PAST_VENOUS_HX_SECTION_CODE);
    expect(view.fields.find((f) => f.code === "venous_hx_dvt")?.value.checked).toBe(true);
    expect(view.fields.find((f) => f.code === "venous_hx_phlebitis")?.version).toBe(0);
  });
});
