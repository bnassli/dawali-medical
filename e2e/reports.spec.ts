import { expect, test, type Page } from "@playwright/test";
import { createVisitFixture, loginAs, visitUrl } from "./support";

/** R5 (ADR-034): data-driven .docx reports with diagrams, preview, draft/final/amended. */

async function saveLegDiagram(page: Page, visit: { patientId: string; visitId: string }) {
  await page.goto(visitUrl(visit));
  await page.getByRole("region", { name: "Diagrams" }).getByRole("link", { name: "Create Leg Diagram" }).click();
  const box = await page.getByLabel(/drawing area/).boundingBox();
  if (!box) throw new Error("no canvas");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.32, box.y + box.height * 0.6, { steps: 5 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("diagram-version")).toHaveText("Version 1");
}

test("Template 1: warns without a Leg Diagram; with one, previews, finalizes a .docx, then amends", async ({ page, browser }) => {
  const visit = await createVisitFixture();
  await loginAs(page, "doctor");
  await page.goto(visitUrl(visit));
  await page.getByRole("region", { name: "Reports" }).getByRole("link", { name: /Template 1/ }).click();
  await expect(page.getByText(/No saved Leg Diagram for this visit/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Finalize" })).toBeDisabled();

  await saveLegDiagram(page, visit);
  await page.goto(visitUrl(visit));
  await page.getByRole("region", { name: "Reports" }).getByRole("link", { name: /Template 1/ }).click();
  await page.getByLabel("Report text").fill("Sclerotherapy of both legs with 0.25% foamed polidocanol.");
  const preview = page.getByRole("region", { name: "Report preview" });
  await expect(preview).toContainText("Sclerotherapy of both legs");
  await expect(preview.getByRole("img", { name: "leg diagram" })).toBeVisible();

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByTestId("report-status")).toHaveText("Version 1 — draft");
  await page.getByRole("button", { name: "Finalize" }).click();
  await expect(page.getByTestId("report-status")).toHaveText("Version 2 — final");
  const download = page.getByRole("link", { name: "Download .docx" });
  const res = await page.request.get((await download.getAttribute("href")) ?? "");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-disposition"]).toMatch(/attachment; filename=".*_Report_Template1_v02\.docx"/);

  // After finalizing, there is no draft any more: changes become an amended version.
  await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
  await page.getByLabel("Report text").fill("Corrected text.");
  await page.getByRole("button", { name: "Save amended version" }).click();
  await expect(page.getByTestId("report-status")).toHaveText("Version 3 — amended");

  await page.goto(visitUrl(visit));
  const reports = page.getByRole("region", { name: "Reports" });
  await expect(reports.getByRole("link", { name: /_Report_Template1_v0[23]\.docx$/ })).toHaveCount(2);

  const nurseCtx = await browser.newContext();
  try {
    const nurse = await nurseCtx.newPage();
    await loginAs(nurse, "nurse");
    await nurse.goto(visitUrl(visit));
    await nurse.getByRole("region", { name: "Reports" }).getByRole("link", { name: "Open" }).click();
    await expect(nurse.getByText("Only a doctor can finalize a report.")).toBeVisible();
  } finally {
    await nurseCtx.close();
  }
});
