import { expect, test, type Page } from "@playwright/test";
import { loadActorContext } from "../src/modules/auth/service";
import { createPatient } from "../src/modules/patients/service";
import { createVisit } from "../src/modules/visits/service";
import { entryHistory, field, loginAs, statusOf, uniq, user, visitUrl, withDb, type VisitFixture } from "./support";

/** R1b (ADR-029): clinical UI reconciliation in the browser. */

async function visitFor(sex?: "F" | "M"): Promise<VisitFixture> {
  return withDb(async (db) => {
    const actor = await loadActorContext(db, user("doctor").userId);
    if (!actor) throw new Error("doctor actor not found");
    const s = uniq();
    const patient = await createPatient(db, actor, { firstName: `R1b-${s}`, lastName: `E2E-${s}`, sex });
    const visit = await createVisit(db, actor, { patientId: patient.id, reason: undefined });
    return { patientId: patient.id, visitId: visit.id };
  });
}

const tab = (v: VisitFixture, code: string) => `${visitUrl(v)}?tab=${code}`;
const FEMALE_LABEL = "If FEMALE select the appropriate statement; otherwise disregard";
const legends = (page: Page) => page.locator(".clinical-group > legend");

test.describe("R1b clinical reconciliation", () => {
  test("Past Medical Hx: the Female-specific statement is 7th for a Female patient and absent otherwise", async ({
    page,
  }) => {
    const female = await visitFor("F");
    const male = await visitFor("M");
    const s = uniq();
    await loginAs(page, "doctor");

    await page.goto(tab(female, "past_medical_hx"));
    const labels = page.locator(".clinical-field .field-head label");
    await expect(labels).toHaveCount(7);
    await expect(labels.nth(6)).toHaveText(FEMALE_LABEL);
    const stmt = field(page, "female_specific_statement");
    await stmt.getByLabel(`New ${FEMALE_LABEL} option`).fill(`Post-menopausal ${s}`);
    await stmt.getByRole("button", { name: "+ Add New" }).click();
    await expect(statusOf(page, "female_specific_statement")).toHaveText("Saved");
    await page.reload();
    await expect(stmt.getByRole("combobox").locator("option:checked")).toHaveText(`Post-menopausal ${s}`);

    await page.goto(tab(male, "past_medical_hx"));
    await expect(page.locator(".clinical-field .field-head label")).toHaveCount(6);
    await expect(page.getByText(FEMALE_LABEL)).toHaveCount(0);
  });

  test("Impression: 8 ordered rows, order kept as typed, Bullets / Numbers stored per visit", async ({ page }) => {
    const visit = await visitFor();
    await loginAs(page, "doctor");
    await page.goto(tab(visit, "assessment_plan"));

    const imp = field(page, "impression_rows");
    await expect(imp.locator(".ordered-row")).toHaveCount(8);
    await expect(field(page, "recommendation_rows").locator(".ordered-row")).toHaveCount(8);
    await expect(field(page, "recommendation_rows").getByRole("radiogroup")).toHaveCount(0);

    // Type row 3 first, then row 1: positions are kept, never re-sorted.
    await imp.getByLabel("Impression row 3 — free text").fill("third finding");
    await imp.getByLabel("Impression row 1 — free text").fill("first finding");
    await expect(statusOf(page, "impression_rows")).toHaveText("Saved");
    await expect(imp.locator(".row-marker").first()).toHaveText("•");

    await imp.getByRole("radio", { name: "Numbers" }).check();
    await expect(statusOf(page, "impression_rows")).toHaveText("Saved");
    await expect(imp.locator(".row-marker").first()).toHaveText("1.");

    await page.reload();
    await expect(imp.getByRole("radio", { name: "Numbers" })).toBeChecked();
    await expect(imp.getByLabel("Impression row 1 — free text")).toHaveValue("first finding");
    await expect(imp.getByLabel("Impression row 2 — free text")).toHaveValue("");
    await expect(imp.getByLabel("Impression row 3 — free text")).toHaveValue("third finding");

    const last = (await entryHistory(visit.visitId, "impression_rows")).at(-1);
    expect(last?.rows?.map((r) => r.freeText)).toEqual(["first finding", "", "third finding"]);
    expect(last?.display).toBe("numbers");
    expect(await entryHistory(visit.visitId, "impression_init_venous_interp")).toHaveLength(0);
  });

  test("Stockings measurements are numeric centimetres; invalid input is never saved", async ({ page }) => {
    const visit = await visitFor();
    await loginAs(page, "doctor");
    await page.goto(tab(visit, "assessment_plan"));

    const thigh = field(page, "stockings_mid_thigh");
    await expect(thigh.getByText("cm", { exact: true })).toBeVisible();
    await thigh.getByRole("spinbutton").fill("52.5");
    await expect(statusOf(page, "stockings_mid_thigh")).toHaveText("Saved");

    const knee = field(page, "stockings_floor_to_knee");
    await knee.getByRole("spinbutton").fill("400");
    await expect(knee.getByText("Enter a number from 0 to 300 cm.")).toBeVisible();
    await knee.getByRole("spinbutton").blur();

    await page.reload();
    await expect(thigh.getByRole("spinbutton")).toHaveValue("52.5");
    expect((await entryHistory(visit.visitId, "stockings_mid_thigh")).map((r) => r.numberValue)).toEqual([52.5]);
    expect(await entryHistory(visit.visitId, "stockings_floor_to_knee")).toHaveLength(0);
  });

  test("Subj Complaints Habits is grouped into the reviewed blocks; the progression checkbox saves", async ({
    page,
  }) => {
    const visit = await visitFor();
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));

    await expect(legends(page)).toHaveText([
      "Reason for visit / Problem List",
      "Chief Complaints",
      "Aggravating / Relieving Factors",
      "Previous conservative therapy",
      "Family history",
      "Habits",
      "Medications / Allergies",
    ]);
    const group = (name: string) =>
      page.locator(".clinical-group", { has: page.locator("legend", { hasText: name }) });
    const labelsIn = (name: string) => group(name).locator(".clinical-field .field-head label");
    await expect(labelsIn("Chief Complaints")).toContainText([
      "How long?",
      "Affects daily living activities?",
      "Additional Comments",
      "Comment",
    ]);
    await expect(labelsIn("Previous conservative therapy")).toHaveText([
      "Previous Conservative Therapy",
      "How long?",
    ]);
    const habits = group("Habits");
    await expect(habits.locator("[data-field]")).toHaveCount(3);

    const worse = field(page, "symptoms_worse_over_time");
    await worse.getByRole("checkbox", { name: "Symptoms getting worse over time?" }).check();
    await expect(statusOf(page, "symptoms_worse_over_time")).toHaveText("Saved");
    await page.reload();
    await expect(worse.getByRole("checkbox", { name: "Symptoms getting worse over time?" })).toBeChecked();
    expect((await entryHistory(visit.visitId, "symptoms_worse_over_time")).at(-1)?.checked).toBe(true);
  });
});
