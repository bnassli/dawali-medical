import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { clinicalFieldDefinitions } from "@/db/schema";
import { FOLLOW_UP_FIELD_CODES, LASER_ABLATION_FIELD_CODES } from "@/modules/clinical/definitions";
import { layoutFieldCodes, SECTION_LAYOUTS } from "@/modules/clinical/layouts";
import {
  addClinicalOption,
  getClinicalSectionForVisit,
  InvalidClinicalValueError,
  listClinicalSections,
  saveClinicalEntry,
} from "@/modules/clinical/service";
import { createPatient } from "@/modules/patients/service";
import { createVisit } from "@/modules/visits/service";
import type { ActorContext } from "@/modules/permissions/types";
import { createTestUser, openTestDb, uniqueSuffix } from "./helpers";

describe("R3: Laser Ablation and Follow Up Office Visit (ADR-031)", () => {
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
      firstName: `R3-${s}`,
      lastName: `Tabs-${s}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });
    return (await createVisit(db, doctor, { patientId: p.id, reason: undefined })).id;
  }
  async function id(code: string) {
    const [row] = await db.select().from(clinicalFieldDefinitions).where(eq(clinicalFieldDefinitions.code, code));
    return row!.id;
  }
  const save = async (visit: string, code: string, value: { optionIds?: string[]; freeText?: string }) =>
    saveClinicalEntry(db, doctor, {
      visitId: visit,
      fieldId: await id(code),
      optionIds: value.optionIds ?? [],
      freeText: value.freeText ?? "",
      expectedVersion: 0,
      clientMutationId: randomUUID(),
    });

  it("adds the tabs in SonoSoft's Treatment order, each field placed in order and on the screen", async () => {
    // Other test files leave extra sections in the shared database; only ours count.
    const ours = ["assessment_plan", "treatment_plan", "laser_ablation", "follow_up_office_visit"];
    const codes = (await listClinicalSections(db, doctor)).map((t) => t.code).filter((c) => ours.includes(c));
    expect(codes).toEqual([
      "assessment_plan",
      "treatment_plan",
      "laser_ablation",
      "follow_up_office_visit",
    ]);
    const v = await visitId();
    for (const [section, expected] of [
      ["laser_ablation", LASER_ABLATION_FIELD_CODES],
      ["follow_up_office_visit", FOLLOW_UP_FIELD_CODES],
    ] as const) {
      const view = await getClinicalSectionForVisit(db, doctor, v, section);
      expect(view.fields.map((f) => f.code)).toEqual(expected);
      const layout = SECTION_LAYOUTS[section];
      expect(new Set(layoutFieldCodes(layout!))).toEqual(new Set(expected));
    }
  });

  it("Patient feels takes only Better / Worse / Same as last visit", async () => {
    const v = await visitId();
    await expect(save(v, "followup_patient_feels", { freeText: "same" })).resolves.toMatchObject({ changed: true });
    await expect(save(await visitId(), "followup_patient_feels", { freeText: "great" })).rejects.toBeInstanceOf(
      InvalidClinicalValueError,
    );
  });

  it("row fields share one list: an Assessment option works on every row, not on Plan", async () => {
    const v = await visitId();
    const opt = await addClinicalOption(db, doctor, { fieldId: await id("followup_assessment_1"), label: `Improved ${uniqueSuffix()}` });
    await expect(save(v, "followup_assessment_3", { optionIds: [opt.id] })).resolves.toMatchObject({ changed: true });
    await expect(save(v, "followup_plan_1", { optionIds: [opt.id] })).rejects.toBeInstanceOf(InvalidClinicalValueError);
    const agent = await addClinicalOption(db, doctor, { fieldId: await id("laser_agent_1"), label: `Tumescent ${uniqueSuffix()}` });
    await expect(save(v, "laser_agent_3", { optionIds: [agent.id], freeText: "extra" })).resolves.toMatchObject({
      changed: true,
    });
  });
});
