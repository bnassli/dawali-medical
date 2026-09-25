import { expect, test } from "@playwright/test";
import { createVisitFixture, entryHistory, field, loginAs, newOptionInput, statusOf, uniq, visitUrl } from "./support";

/** R3 (ADR-031): Laser Ablation and Follow Up Office Visit in SonoSoft layout. */

test("Laser Ablation: combo boxes and text boxes save and survive a reload", async ({ page }) => {
  const visit = await createVisitFixture();
  const s = uniq();
  await loginAs(page, "doctor");
  await page.goto(`${visitUrl(visit)}?tab=laser_ablation`);
  await expect(page.getByText("Please set your Laser Machine as default")).toBeVisible();

  const vessel = field(page, "laser_vessel").getByRole("combobox");
  await vessel.fill(`GSV ${s}`);
  await vessel.blur();
  await expect(statusOf(page, "laser_vessel")).toHaveText("Saved");
  const start = field(page, "laser_start_cm").locator("input");
  await start.fill("3");
  await start.blur();
  await expect(statusOf(page, "laser_start_cm")).toHaveText("Saved");
  await (await newOptionInput(page, "laser_agent_1", "Agent 1")).fill(`Tumescent ${s}`);
  await field(page, "laser_agent_1").getByRole("button", { name: "+ Add New" }).click();
  await expect(statusOf(page, "laser_agent_1")).toHaveText("Saved");

  await page.reload();
  await expect(field(page, "laser_vessel").getByRole("combobox")).toHaveValue(`GSV ${s}`);
  await expect(field(page, "laser_start_cm").locator("input")).toHaveValue("3");
  await expect(field(page, "laser_agent_1").getByRole("combobox")).toHaveValue(`Tumescent ${s}`);
});

test("Follow Up Office Visit: Patient feels, Assessment rows and Plan Select", async ({ page }) => {
  const visit = await createVisitFixture();
  const s = uniq();
  await loginAs(page, "doctor");
  await page.goto(`${visitUrl(visit)}?tab=follow_up_office_visit`);

  await page.getByRole("radiogroup", { name: "Patient feels" }).getByRole("radio", { name: "Same as last visit" }).check();
  await expect(statusOf(page, "followup_patient_feels")).toHaveText("Saved");
  const a2 = field(page, "followup_assessment_2").getByRole("combobox");
  await a2.fill(`Healing well ${s}`);
  await a2.blur();
  await expect(statusOf(page, "followup_assessment_2")).toHaveText("Saved");

  await (await newOptionInput(page, "followup_plan_1", "Plan 1")).fill(`Stockings 3 months ${s}`);
  await field(page, "followup_plan_1").getByRole("button", { name: "+ Add New" }).click();
  await expect(statusOf(page, "followup_plan_1")).toHaveText("Saved");
  // SonoSoft's "Select" puts the chosen plan into the next empty row.
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("listbox", { name: "Select" }).getByRole("option", { name: `Stockings 3 months ${s}` }).click();
  await expect(statusOf(page, "followup_plan_2")).toHaveText("Saved");

  await page.reload();
  await expect(page.getByRole("radio", { name: "Same as last visit" })).toBeChecked();
  await expect(field(page, "followup_assessment_2").getByRole("combobox")).toHaveValue(`Healing well ${s}`);
  await expect(field(page, "followup_plan_2").getByRole("combobox")).toHaveValue(`Stockings 3 months ${s}`);
  expect((await entryHistory(visit.visitId, "followup_patient_feels")).map((r) => r.freeText)).toEqual(["same"]);
});
