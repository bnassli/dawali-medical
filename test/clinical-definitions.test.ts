import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  clinicalEntries,
  clinicalFieldDefinitions,
  clinicalOptionLists,
  clinicalSections,
} from "@/db/schema";
import { seedClinicalDefinitions, StructuralDefinitionChangeError } from "@/db/seed";
import {
  assertDefinitionsConsistent,
  DEFAULT_CLINICAL_DEFINITIONS,
  FIELD_TYPES,
  SUBJ_COMPLAINTS_HABITS_SECTION_CODE,
  type ClinicalDefinitions,
} from "@/modules/clinical/definitions";
import {
  addClinicalOption,
  ClinicalFieldNotFoundError,
  ClinicalSectionNotFoundError,
  getClinicalSectionForVisit,
} from "@/modules/clinical/service";
import { createPatient } from "@/modules/patients/service";
import type { ActorContext } from "@/modules/permissions/types";
import { createVisit } from "@/modules/visits/service";
import { createTestUser, openTestDb, saveCurrent, uniqueSuffix } from "./helpers";

describe("clinical definitions: global fields, section placement, reusable lists, safe seeding", () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(() => {
    const opened = openTestDb();
    db = opened.db;
    close = opened.close;
  });

  afterAll(async () => {
    await close();
  });

  const defaults = DEFAULT_CLINICAL_DEFINITIONS;

  function withExtra(extra: {
    fields?: ClinicalDefinitions["fields"];
    sections?: ClinicalDefinitions["sections"];
  }): ClinicalDefinitions {
    return {
      fields: [...defaults.fields, ...(extra.fields ?? [])],
      sections: [...defaults.sections, ...(extra.sections ?? [])],
    };
  }

  async function newVisit(actor: ActorContext) {
    const s = uniqueSuffix();
    const patient = await createPatient(db, actor, {
      firstName: `Def-${s}`,
      lastName: `Init-${s}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });
    return createVisit(db, actor, { patientId: patient.id, reason: undefined });
  }

  async function fieldId(code: string): Promise<string> {
    const [row] = await db
      .select({ id: clinicalFieldDefinitions.id })
      .from(clinicalFieldDefinitions)
      .where(eq(clinicalFieldDefinitions.code, code))
      .limit(1);
    if (!row) throw new Error(`field ${code} not seeded`);
    return row.id;
  }

  async function rowCounts() {
    const one = async (table: string) => {
      const r = await db.execute<{ n: string }>(sql.raw(`SELECT count(*)::text AS n FROM ${table}`));
      return Number(r.rows[0]?.n ?? 0);
    };
    return {
      sections: await one("clinical_sections"),
      fields: await one("clinical_field_definitions"),
      lists: await one("clinical_option_lists"),
      placements: await one("clinical_section_fields"),
      options: await one("clinical_options"),
    };
  }

  describe("global fields (ADR-026)", () => {
    it("field codes are globally unique in the database", async () => {
      await expect(
        db.insert(clinicalFieldDefinitions).values({
          code: "allergies",
          label: "Allergies again",
          fieldType: FIELD_TYPES.MULTISELECT,
        }),
      ).rejects.toThrow();
    });

    it("the default definitions are consistent, and inconsistent ones are rejected", () => {
      expect(() => assertDefinitionsConsistent(defaults)).not.toThrow();
      expect(() =>
        assertDefinitionsConsistent({
          fields: [
            { code: "a", label: "A", type: FIELD_TYPES.TEXT },
            { code: "a", label: "A2", type: FIELD_TYPES.TEXT },
          ],
          sections: [],
        }),
      ).toThrow(/Duplicate global field code/);
      expect(() =>
        assertDefinitionsConsistent({
          fields: [{ code: "a", label: "A", type: FIELD_TYPES.TEXT }],
          sections: [{ code: "s", name: "S", sortOrder: 1, fieldCodes: ["missing"] }],
        }),
      ).toThrow(/unknown field/);
      expect(() =>
        assertDefinitionsConsistent({
          fields: [{ code: "a", label: "A", type: FIELD_TYPES.TEXT, optionList: "list" }],
          sections: [],
        }),
      ).toThrow(/cannot have an option list/);
      expect(() =>
        assertDefinitionsConsistent({
          fields: [{ code: "a", label: "A", type: FIELD_TYPES.TEXT }],
          sections: [{ code: "s", name: "S", sortOrder: 1, fieldCodes: ["a", "a"] }],
        }),
      ).toThrow(/twice/);
    });

    it("one concept in two tabs has ONE source of truth: same field row, same entries, no duplicate data", async () => {
      const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
      const visit = await newVisit(actor);
      const s = uniqueSuffix();
      const tab2 = `later_tab_${s}`;
      await seedClinicalDefinitions(
        db,
        withExtra({
          sections: [
            {
              code: tab2,
              name: "A later tab",
              sortOrder: 50,
              // Current Meds / Allergies / Family History reappear, in another order, plus reason.
              fieldCodes: ["allergies", "current_meds", "family_history", "reason_for_visit"],
            },
          ],
        }),
      );

      const first = await getClinicalSectionForVisit(db, actor, visit.id, SUBJ_COMPLAINTS_HABITS_SECTION_CODE);
      const second = await getClinicalSectionForVisit(db, actor, visit.id, tab2);
      expect(second.fields.map((f) => f.code)).toEqual([
        "allergies",
        "current_meds",
        "family_history",
        "reason_for_visit",
      ]);
      // Same global field ids in both tabs.
      for (const f of second.fields) {
        expect(first.fields.find((x) => x.code === f.code)?.id).toBe(f.id);
      }

      // Save through the FIRST tab; the second tab sees it immediately (one entry stream).
      const allergiesId = await fieldId("allergies");
      const option = await addClinicalOption(db, actor, {
        fieldId: allergiesId,
        label: `Penicillin ${s}`,
      });
      await saveCurrent(db, actor, {
        visitId: visit.id,
        fieldId: allergiesId,
        optionIds: [option.id],
        freeText: "rash",
      });
      const again = await getClinicalSectionForVisit(db, actor, visit.id, tab2);
      const allergies = again.fields.find((f) => f.code === "allergies");
      expect(allergies?.version).toBe(1);
      expect(allergies?.value).toEqual({ optionIds: [option.id], freeText: "rash" });

      const rows = await db.select().from(clinicalEntries).where(eq(clinicalEntries.visitId, visit.id));
      expect(rows).toHaveLength(1);

      // Placing a concept in another tab never creates a second field definition.
      const dupes = await db.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM clinical_field_definitions WHERE code = 'allergies'`,
      );
      expect(dupes.rows[0]?.n).toBe("1");
    });

    it("option lists are reusable: two fields can share one list and its values", async () => {
      const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
      const visit = await newVisit(actor);
      const s = uniqueSuffix();
      const a = `shared_a_${s}`;
      const b = `shared_b_${s}`;
      const tab = `shared_tab_${s}`;
      await seedClinicalDefinitions(
        db,
        withExtra({
          fields: [
            { code: a, label: "Shared A", type: FIELD_TYPES.MULTISELECT, optionList: `list_${s}` },
            { code: b, label: "Shared B", type: FIELD_TYPES.SELECT, optionList: `list_${s}` },
          ],
          sections: [{ code: tab, name: "Shared tab", sortOrder: 51, fieldCodes: [a, b] }],
        }),
      );

      const lists = await db
        .select()
        .from(clinicalOptionLists)
        .where(eq(clinicalOptionLists.code, `list_${s}`));
      expect(lists).toHaveLength(1);
      const fieldA = await fieldId(a);
      const fieldB = await fieldId(b);
      const defs = await db
        .select({ id: clinicalFieldDefinitions.id, listId: clinicalFieldDefinitions.optionListId })
        .from(clinicalFieldDefinitions);
      expect(defs.find((d) => d.id === fieldA)?.listId).toBe(lists[0]?.id);
      expect(defs.find((d) => d.id === fieldB)?.listId).toBe(lists[0]?.id);

      // A value added through field A is a valid choice for field B.
      const option = await addClinicalOption(db, actor, { fieldId: fieldA, label: `Common ${s}` });
      const view = await getClinicalSectionForVisit(db, actor, visit.id, tab);
      expect(view.fields.find((f) => f.code === b)?.options.map((o) => o.id)).toContain(option.id);
      await expect(
        saveCurrent(db, actor, { visitId: visit.id, fieldId: fieldB, optionIds: [option.id], freeText: "" }),
      ).resolves.toMatchObject({ changed: true });
      // Entries stay per field: A is untouched.
      const after = await getClinicalSectionForVisit(db, actor, visit.id, tab);
      expect(after.fields.find((f) => f.code === a)?.version).toBe(0);
      expect(after.fields.find((f) => f.code === b)?.version).toBe(1);
    });

    it("placement order is presentation only: reordering changes order, never data or field rows", async () => {
      const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
      const visit = await newVisit(actor);
      const s = uniqueSuffix();
      const tab = `order_tab_${s}`;
      const codes = ["comments", "alcohol", "tobacco"];
      await seedClinicalDefinitions(
        db,
        withExtra({ sections: [{ code: tab, name: "Order", sortOrder: 52, fieldCodes: codes }] }),
      );
      await saveCurrent(db, actor, {
        visitId: visit.id,
        fieldId: await fieldId("comments"),
        optionIds: [],
        freeText: "kept",
      });
      const before = await rowCounts();

      const reversed = [...codes].reverse();
      await seedClinicalDefinitions(
        db,
        withExtra({ sections: [{ code: tab, name: "Order", sortOrder: 52, fieldCodes: reversed }] }),
      );
      const view = await getClinicalSectionForVisit(db, actor, visit.id, tab);
      expect(view.fields.map((f) => f.code)).toEqual(reversed);
      expect(view.fields.find((f) => f.code === "comments")?.value.freeText).toBe("kept");
      expect(await rowCounts()).toEqual(before);
    });

    it("an unknown section is a clean error", async () => {
      const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
      const visit = await newVisit(actor);
      await expect(getClinicalSectionForVisit(db, actor, visit.id, "no_such_tab")).rejects.toBeInstanceOf(
        ClinicalSectionNotFoundError,
      );
    });
  });

  describe("seed never silently changes structure (ADR-026)", () => {
    it("is idempotent: re-seeding the defaults changes no rows", async () => {
      await seedClinicalDefinitions(db);
      const before = await rowCounts();
      await seedClinicalDefinitions(db);
      await seedClinicalDefinitions(db, defaults);
      expect(await rowCounts()).toEqual(before);
    });

    it("refuses a field TYPE change, changes nothing, and rolls back everything else in the same run", async () => {
      const before = await rowCounts();
      const s = uniqueSuffix();
      const changed: ClinicalDefinitions = {
        fields: [
          ...defaults.fields.map((f) =>
            f.code === "duration" ? { ...f, type: FIELD_TYPES.MULTISELECT } : f,
          ),
          { code: `new_field_${s}`, label: "Brand new", type: FIELD_TYPES.TEXT },
        ],
        sections: [
          ...defaults.sections,
          { code: `new_tab_${s}`, name: "Brand new tab", sortOrder: 60, fieldCodes: [`new_field_${s}`] },
        ],
      };
      await expect(seedClinicalDefinitions(db, changed)).rejects.toBeInstanceOf(
        StructuralDefinitionChangeError,
      );
      await expect(seedClinicalDefinitions(db, changed)).rejects.toThrow(/requires a migration/);

      const [duration] = await db
        .select()
        .from(clinicalFieldDefinitions)
        .where(eq(clinicalFieldDefinitions.code, "duration"));
      expect(duration?.fieldType).toBe(FIELD_TYPES.SELECT);
      // The new field/section from the same (rejected) run were not created either.
      expect(await rowCounts()).toEqual(before);
    });

    it("refuses an OPTION LIST change and does not create the new list", async () => {
      const before = await rowCounts();
      const s = uniqueSuffix();
      const changed: ClinicalDefinitions = {
        fields: defaults.fields.map((f) =>
          f.code === "progression" ? { ...f, optionList: `other_list_${s}` } : f,
        ),
        sections: defaults.sections,
      };
      const error = await seedClinicalDefinitions(db, changed).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StructuralDefinitionChangeError);
      expect(String((error as Error).message)).toContain("option list");
      expect(await rowCounts()).toEqual(before);
      const lists = await db
        .select()
        .from(clinicalOptionLists)
        .where(eq(clinicalOptionLists.code, `other_list_${s}`));
      expect(lists).toHaveLength(0);
    });

    it("refuses turning a select field into a text field (and vice versa)", async () => {
      await expect(
        seedClinicalDefinitions(db, {
          fields: defaults.fields.map((f) => (f.code === "alcohol" ? { ...f, type: FIELD_TYPES.TEXT } : f)),
          sections: defaults.sections,
        }),
      ).rejects.toBeInstanceOf(StructuralDefinitionChangeError);
      await expect(
        seedClinicalDefinitions(db, {
          fields: defaults.fields.map((f) => (f.code === "comments" ? { ...f, type: FIELD_TYPES.SELECT } : f)),
          sections: defaults.sections,
        }),
      ).rejects.toBeInstanceOf(StructuralDefinitionChangeError);
    });

    it("refuses when a field's free-text flag was changed in the database", async () => {
      const s = uniqueSuffix();
      const code = `flag_field_${s}`;
      const defs = withExtra({ fields: [{ code, label: "Flag", type: FIELD_TYPES.TEXT }] });
      await seedClinicalDefinitions(db, defs);
      await db.execute(sql`UPDATE clinical_field_definitions SET allows_free_text = false WHERE code = ${code}`);
      await expect(seedClinicalDefinitions(db, defs)).rejects.toBeInstanceOf(StructuralDefinitionChangeError);
    });

    it("still allows cosmetic changes: labels, and never touches option rows or entries", async () => {
      const original = defaults.fields.find((f) => f.code === "comments");
      expect(original).toBeDefined();
      const relabelled: ClinicalDefinitions = {
        fields: defaults.fields.map((f) => (f.code === "comments" ? { ...f, label: "Comments (renamed)" } : f)),
        sections: defaults.sections,
      };
      const before = await rowCounts();
      try {
        await seedClinicalDefinitions(db, relabelled);
        const [row] = await db
          .select()
          .from(clinicalFieldDefinitions)
          .where(eq(clinicalFieldDefinitions.code, "comments"));
        expect(row?.label).toBe("Comments (renamed)");
        expect(row?.fieldType).toBe(FIELD_TYPES.TEXTAREA);
        expect(await rowCounts()).toEqual(before);
      } finally {
        await seedClinicalDefinitions(db, defaults);
      }
      const [restored] = await db
        .select()
        .from(clinicalFieldDefinitions)
        .where(eq(clinicalFieldDefinitions.code, "comments"));
      expect(restored?.label).toBe("Comments");
    });

    it("refuses a section that places an unknown field, before touching the database", async () => {
      const before = await rowCounts();
      await expect(
        seedClinicalDefinitions(db, {
          fields: defaults.fields,
          sections: [{ code: "bad_tab", name: "Bad", sortOrder: 70, fieldCodes: ["does_not_exist"] }],
        }),
      ).rejects.toThrow(/unknown field/);
      expect(await rowCounts()).toEqual(before);
      const sections = await db.select().from(clinicalSections).where(eq(clinicalSections.code, "bad_tab"));
      expect(sections).toHaveLength(0);
    });
  });

  describe("retired fields keep their history visible, read-only (ADR-026)", () => {
    async function retiredFixture() {
      const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
      const visitWithHistory = await newVisit(actor);
      const visitWithout = await newVisit(actor);
      const s = uniqueSuffix();
      const code = `retire_me_${s}`;
      const tab = `retire_tab_${s}`;
      await seedClinicalDefinitions(
        db,
        withExtra({
          fields: [{ code, label: "Retire me", type: FIELD_TYPES.TEXTAREA }],
          sections: [{ code: tab, name: "Retire tab", sortOrder: 80, fieldCodes: ["comments", code] }],
        }),
      );
      const id = await fieldId(code);
      await saveCurrent(db, actor, {
        visitId: visitWithHistory.id,
        fieldId: id,
        optionIds: [],
        freeText: "history that must never vanish",
      });
      return { actor, visitWithHistory, visitWithout, code, tab, id };
    }

    it("stays visible (marked inactive, value intact) on visits that have entries; hidden where there is nothing to lose", async () => {
      const f = await retiredFixture();
      await db.execute(sql`UPDATE clinical_field_definitions SET is_active = false WHERE id = ${f.id}`);

      const withHistory = await getClinicalSectionForVisit(db, f.actor, f.visitWithHistory.id, f.tab);
      const retired = withHistory.fields.find((x) => x.code === f.code);
      expect(retired).toMatchObject({
        isActive: false,
        version: 1,
        value: { optionIds: [], freeText: "history that must never vanish" },
      });
      // Order is preserved: comments first, the retired field where it was placed.
      expect(withHistory.fields.map((x) => x.code)).toEqual(["comments", f.code]);
      expect(withHistory.fields.find((x) => x.code === "comments")?.isActive).toBe(true);

      const without = await getClinicalSectionForVisit(db, f.actor, f.visitWithout.id, f.tab);
      expect(without.fields.map((x) => x.code)).toEqual(["comments"]);
    });

    it("cannot be edited while retired (no new revision), and history is untouched; reactivating restores editing", async () => {
      const f = await retiredFixture();
      await db.execute(sql`UPDATE clinical_field_definitions SET is_active = false WHERE id = ${f.id}`);

      await expect(
        saveCurrent(db, f.actor, {
          visitId: f.visitWithHistory.id,
          fieldId: f.id,
          optionIds: [],
          freeText: "edit after retirement",
        }),
      ).rejects.toBeInstanceOf(ClinicalFieldNotFoundError);
      const rows = await db.select().from(clinicalEntries).where(eq(clinicalEntries.fieldDefinitionId, f.id));
      expect(rows.map((r) => r.value.freeText)).toEqual(["history that must never vanish"]);

      await db.execute(sql`UPDATE clinical_field_definitions SET is_active = true WHERE id = ${f.id}`);
      await expect(
        saveCurrent(db, f.actor, {
          visitId: f.visitWithHistory.id,
          fieldId: f.id,
          optionIds: [],
          freeText: "edit after reactivation",
        }),
      ).resolves.toMatchObject({ changed: true, version: 2 });
    });

    it("a retired select field still shows its selected (even retired) options", async () => {
      const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
      const visit = await newVisit(actor);
      const id = await fieldId("exercise");
      const option = await addClinicalOption(db, actor, { fieldId: id, label: `Jogging ${uniqueSuffix()}` });
      await saveCurrent(db, actor, { visitId: visit.id, fieldId: id, optionIds: [option.id], freeText: "" });
      await db.execute(sql`UPDATE clinical_field_definitions SET is_active = false WHERE id = ${id}`);
      try {
        const view = await getClinicalSectionForVisit(db, actor, visit.id, SUBJ_COMPLAINTS_HABITS_SECTION_CODE);
        const exercise = view.fields.find((x) => x.code === "exercise");
        expect(exercise?.isActive).toBe(false);
        expect(exercise?.options.map((o) => o.id)).toContain(option.id);
        expect(exercise?.value.optionIds).toEqual([option.id]);
      } finally {
        await db.execute(sql`UPDATE clinical_field_definitions SET is_active = true WHERE id = ${id}`);
      }
    });
  });
});
