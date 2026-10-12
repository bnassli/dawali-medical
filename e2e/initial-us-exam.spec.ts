import { expect, test } from "@playwright/test";
import { closeVisit, createVisitFixture, entryHistory, field, loginAs, statusOf, visitUrl } from "./support";

/** ADR-041: Initial US Exam, SonoSoft's Workup ultrasound tab. */
test.describe("Initial US Exam", () => {
  test("sits after Past Medical Hx; both legs, findings and DVT persist across a reload", async ({ page }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));

    const tabs = page.getByRole("navigation", { name: "Clinical tabs" });
    const names = (await tabs.locator(".tab").allTextContents()).map((t) => t.trim());
    expect(names.indexOf("Initial US Exam")).toBe(names.indexOf("Past Medical Hx") + 1);
    expect(names.indexOf("Assessment Plan+")).toBe(names.indexOf("Initial US Exam") + 1);

    await tabs.getByRole("link", { name: "Initial US Exam" }).click();
    await expect(page.getByText("Right Deep Vessels With Reflux")).toBeVisible();
    await expect(page.getByText("Left Deep Vessels With Reflux")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add'l Measurements" })).toBeVisible();
    for (const dropped of ["Date of Service", "Name of Exam", "Add Charge", "Leg Study", "Branch Tributarie"]) {
      await expect(page.getByText(dropped, { exact: true })).toHaveCount(0);
    }

    await field(page, "ius_r_gsv_status").getByRole("radio", { name: "Incompetent" }).check();
    await expect(statusOf(page, "ius_r_gsv_status")).toHaveText("Saved");
    await field(page, "ius_l_gsv_size_knee").locator("input").fill("6.5");
    await field(page, "ius_l_gsv_size_knee").locator("input").blur();
    await expect(statusOf(page, "ius_l_gsv_size_knee")).toHaveText("Saved");
    await field(page, "ius_r_perf_mid_calf").getByRole("checkbox").check();
    await expect(statusOf(page, "ius_r_perf_mid_calf")).toHaveText("Saved");
    await field(page, "ius_dvt").getByRole("radio", { name: "is NO" }).check();
    await expect(statusOf(page, "ius_dvt")).toHaveText("Saved");

    await page.reload();
    await expect(field(page, "ius_r_gsv_status").getByRole("radio", { name: "Incompetent" })).toBeChecked();
    await expect(field(page, "ius_l_gsv_status").getByRole("radio", { name: "Incompetent" })).not.toBeChecked();
    await expect(field(page, "ius_l_gsv_size_knee").locator("input")).toHaveValue("6.5");
    await expect(field(page, "ius_r_perf_mid_calf").getByRole("checkbox")).toBeChecked();
    await expect(field(page, "ius_dvt").getByRole("radio", { name: "is NO" })).toBeChecked();
    expect(await entryHistory(visit.visitId, "ius_dvt")).toHaveLength(1);
  });

  test("Create Diagram opens a new vein diagram of this visit; a closed visit cannot create one", async ({ page }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "doctor");
    await page.goto(`${visitUrl(visit)}?tab=initial_us_exam`);
    const create = page.getByRole("link", { name: "Create Diagram" });
    await expect(create).toHaveAttribute("href", new RegExp(`/visits/${visit.visitId}/diagrams/[0-9a-f-]{36}\\?type=vein$`));
    await create.click();
    await expect(page).toHaveURL(new RegExp(`/visits/${visit.visitId}/diagrams/`));

    await closeVisit(visit.visitId);
    await page.goto(`${visitUrl(visit)}?tab=initial_us_exam`);
    await expect(page.getByRole("button", { name: "Create Diagram" })).toBeDisabled();
  });
});
