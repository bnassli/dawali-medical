import { expect, test } from "@playwright/test";
import { createVisitFixture, entryHistory, field, loginAs, statusOf, visitUrl } from "./support";

/** ADR-040: Past Venous Hx, SonoSoft's second Workup tab. */
test.describe("Past Venous Hx", () => {
  test("sits between Subj Complaints Habits and Past Medical Hx; boxes and narrative persist across a reload", async ({
    page,
  }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));

    const tabs = page.getByRole("navigation", { name: "Clinical tabs" });
    const names = (await tabs.locator(".tab").allTextContents()).map((t) => t.trim());
    const at = (n: string) => names.indexOf(n);
    expect(at("Past Venous Hx")).toBe(at("Subj Complaints Habits") + 1);
    expect(at("Past Medical Hx")).toBe(at("Past Venous Hx") + 1);

    await tabs.getByRole("link", { name: "Past Venous Hx" }).click();
    for (const label of [
      "Phlebitis",
      "DVT",
      "Pulmonary Embolism",
      "Bleeding from veins",
      "Sclerotherapy",
      "Sonogram",
      "Prior Vein Surgery",
      "Hemorrhoids",
      "IV drug use",
      "AIDS/HIV/Hepatitis",
      "Previous Trauma",
      "Clotting Disorder",
    ]) {
      await expect(page.getByRole("checkbox", { name: label, exact: true })).toBeVisible();
    }
    await expect(page.getByText("Calculate Caprini Score")).toHaveCount(0);

    await field(page, "venous_hx_sclerotherapy").getByRole("checkbox").check();
    await expect(statusOf(page, "venous_hx_sclerotherapy")).toHaveText("Saved");
    await field(page, "vein_history_narrative").getByLabel("Vein History Narrative — visit-only free text").fill("Sclerotherapy in 2019.");
    await expect(statusOf(page, "vein_history_narrative")).toHaveText("Saved");

    await page.reload();
    await expect(field(page, "venous_hx_sclerotherapy").getByRole("checkbox")).toBeChecked();
    await expect(field(page, "venous_hx_phlebitis").getByRole("checkbox")).not.toBeChecked();
    await expect(field(page, "vein_history_narrative").getByLabel("Vein History Narrative — visit-only free text")).toHaveValue(
      "Sclerotherapy in 2019.",
    );
    expect(await entryHistory(visit.visitId, "venous_hx_sclerotherapy")).toHaveLength(1);
  });
});
