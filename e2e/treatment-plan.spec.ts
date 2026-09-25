import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createVisitFixture, field, loginAs, newOptionInput, statusOf, uniq, visitUrl, withDb } from "./support";

/** R2 Treatment Plan (ADR-030): one plan per patient, SonoSoft layout, rows never deleted. */

const TAB = "treatment_plan";
const cellCode = (column: string, row: number) => `treatment_${column}__${row}`;
const tabUrl = (v: { patientId: string; visitId: string }) => `${visitUrl(v)}?tab=${TAB}`;

async function planCells(patientId: string) {
  return withDb(async (db) => {
    const r = await db.execute<{ position: number; code: string; version: number; free_text: string; checked: boolean | null }>(sql`
      SELECT i.position, f.code, e.version, e.value->>'freeText' AS free_text, (e.value->>'checked')::boolean AS checked
      FROM treatment_plan_items i
      JOIN treatment_plan_entries e ON e.item_id = i.id
      JOIN clinical_field_definitions f ON f.id = e.field_definition_id
      WHERE i.patient_id = ${patientId}
      ORDER BY i.position, f.code, e.version`);
    return r.rows;
  });
}

async function typeDate(page: Page, code: string, text: string) {
  const input = field(page, code).locator("input");
  await input.fill(text);
  await input.blur();
}

test.describe("Treatment Plan (R2)", () => {
  test("SonoSoft columns in order; a typed row saves, survives a reload and is the same plan in the next visit", async ({
    page,
  }) => {
    const first = await createVisitFixture();
    const s = uniq();
    await loginAs(page, "doctor");
    await page.goto(tabUrl(first));

    const tabs = page.getByRole("navigation", { name: "Clinical tabs" });
    await expect(tabs.locator(".tab.active")).toHaveText("Treatment Plan");
    for (const heading of [
      "Scheduled",
      "Completed",
      "Recommended Treatment/Procedures in the order to be received",
      "Approval/Status/Comments",
    ]) {
      await expect(page.getByText(heading, { exact: true })).toBeVisible();
    }
    // 25 empty rows, like SonoSoft.
    await expect(page.locator('[data-field^="treatment_procedure__"]')).toHaveCount(25);

    await typeDate(page, cellCode("scheduled", 1), "17/08/2022");
    await expect(statusOf(page, cellCode("scheduled", 1))).toHaveText("Saved");
    const procedure = field(page, cellCode("procedure", 1)).getByRole("combobox");
    await procedure.fill(`Sclerotherapy both legs ${s}`);
    await procedure.blur();
    await expect(statusOf(page, cellCode("procedure", 1))).toHaveText("Saved");
    // "+ Add New" on the status list.
    await (await newOptionInput(page, cellCode("status", 1), "Approval/Status/Comments 1")).fill(`Approved ${s}`);
    await field(page, cellCode("status", 1)).getByRole("button", { name: "+ Add New" }).click();
    await expect(statusOf(page, cellCode("status", 1))).toHaveText("Saved");

    await page.reload();
    await expect(field(page, cellCode("scheduled", 1)).locator("input")).toHaveValue("17/08/2022");
    await expect(field(page, cellCode("procedure", 1)).getByRole("combobox")).toHaveValue(`Sclerotherapy both legs ${s}`);
    await expect(field(page, cellCode("status", 1)).getByRole("combobox")).toHaveValue(`Approved ${s}`);

    // The next visit of the same patient shows the same plan; Completed is filled from there.
    const second = await createVisitFixture({ patientId: first.patientId });
    await page.goto(tabUrl(second));
    await expect(field(page, cellCode("procedure", 1)).getByRole("combobox")).toHaveValue(`Sclerotherapy both legs ${s}`);
    await typeDate(page, cellCode("completed", 1), "18/08/2022");
    await expect(statusOf(page, cellCode("completed", 1))).toHaveText("Saved");
    // The new option is offered on every row (one shared list).
    await field(page, cellCode("status", 2)).getByRole("button", { name: "Open Approval/Status/Comments 2 list" }).click();
    await expect(field(page, cellCode("status", 2)).getByRole("option", { name: `Approved ${s}` })).toBeVisible();

    const cells = await planCells(first.patientId);
    expect(cells.map((c) => [c.position, c.code, c.free_text])).toEqual([
      [1, "treatment_completed", "2022-08-18"],
      [1, "treatment_procedure", `Sclerotherapy both legs ${s}`],
      [1, "treatment_scheduled", "2022-08-17"],
      [1, "treatment_status", ""],
    ]);

    // Another patient's plan is empty.
    const other = await createVisitFixture();
    await page.goto(tabUrl(other));
    await expect(field(page, cellCode("procedure", 1)).getByRole("combobox")).toHaveValue("");
  });

  test("an impossible date is marked and not saved; Cancelled keeps the row", async ({ page }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "doctor");
    await page.goto(tabUrl(visit));

    const procedure = field(page, cellCode("procedure", 1)).getByRole("combobox");
    await procedure.fill("Wrong row");
    await procedure.blur();
    await expect(statusOf(page, cellCode("procedure", 1))).toHaveText("Saved");

    // Refused by the server, kept on screen and flagged, never lost silently.
    await typeDate(page, cellCode("scheduled", 1), "31/02/2026");
    const scheduled = field(page, cellCode("scheduled", 1));
    await expect(scheduled.locator("input")).toHaveAttribute("aria-invalid", "true");
    await expect(statusOf(page, cellCode("scheduled", 1))).toHaveText("Not saved");
    await expect(scheduled).toContainText("must be a real date");
    await expect(page.getByTestId("unsaved-banner")).toContainText("not saved yet");
    await typeDate(page, cellCode("scheduled", 1), "");
    await expect(page.getByTestId("unsaved-banner")).toHaveText("");
    await field(page, cellCode("cancelled", 1)).getByRole("checkbox").check();
    await expect(statusOf(page, cellCode("cancelled", 1))).toHaveText("Saved");

    await page.reload();
    await expect(field(page, cellCode("cancelled", 1)).getByRole("checkbox")).toBeChecked();
    await expect(field(page, cellCode("procedure", 1)).getByRole("combobox")).toHaveValue("Wrong row");
    await expect(field(page, cellCode("scheduled", 1)).locator("input")).toHaveValue("");
    const cells = await planCells(visit.patientId);
    expect(cells.map((c) => c.code)).toEqual(["treatment_cancelled", "treatment_procedure"]);
    expect(cells[0]?.checked).toBe(true);
  });

  test("nurse writes; admin reads only; reception has no clinical tabs", async ({ page, browser }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "nurse");
    await page.goto(tabUrl(visit));
    const procedure = field(page, cellCode("procedure", 1)).getByRole("combobox");
    await procedure.fill("Nurse entry");
    await procedure.blur();
    await expect(statusOf(page, cellCode("procedure", 1))).toHaveText("Saved");

    const adminCtx = await browser.newContext();
    const receptionCtx = await browser.newContext();
    try {
      const admin = await adminCtx.newPage();
      await loginAs(admin, "admin");
      await admin.goto(tabUrl(visit));
      await expect(admin.getByText("read-only access")).toBeVisible();
      await expect(field(admin, cellCode("procedure", 1)).getByRole("combobox")).toHaveValue("Nurse entry");
      await expect(field(admin, cellCode("procedure", 1)).getByRole("combobox")).toBeDisabled();

      const reception = await receptionCtx.newPage();
      await loginAs(reception, "reception");
      await reception.goto(tabUrl(visit));
      await expect(reception.getByText("You do not have access to clinical entries.")).toBeVisible();
      await expect(reception.locator("[data-field]")).toHaveCount(0);
    } finally {
      await adminCtx.close();
      await receptionCtx.close();
    }
  });
});
