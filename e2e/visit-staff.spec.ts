import { expect, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { auditLogs } from "../src/db/schema";
import { closeVisit, createVisitFixture, loginAs, user, visitUrl, withDb } from "./support";

/** ADR-039: the visit's doctor and nurse, above the clinical tabs. */
test.describe("Visit doctor and nurse", () => {
  test("a doctor picks the visit's doctor and nurse; both survive a reload and are audited", async ({ page }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));

    const staff = page.getByRole("region", { name: "Visit staff" });
    const doctor = staff.getByLabel("Doctor", { exact: true });
    const nurse = staff.getByLabel("Nurse", { exact: true });
    await expect(doctor).toHaveValue("");
    await expect(nurse).toHaveValue("");

    await doctor.selectOption(user("doctor").userId);
    await expect(staff.locator("[data-staff=doctor] [role=status]")).toHaveText("Saved");
    await nurse.selectOption(user("nurse").userId);
    await expect(staff.locator("[data-staff=nurse] [role=status]")).toHaveText("Saved");

    await page.reload();
    await expect(doctor).toHaveValue(user("doctor").userId);
    await expect(nurse).toHaveValue(user("nurse").userId);
    // Tabs follow directly; the row is shown on every tab.
    await page.getByRole("navigation", { name: "Clinical tabs" }).getByRole("link", { name: "Past Medical Hx" }).click();
    await expect(doctor).toHaveValue(user("doctor").userId);

    const audits = await withDb((db) =>
      db
        .select({ after: auditLogs.after })
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "visit.staff"), eq(auditLogs.visitId, visit.visitId))),
    );
    expect(audits).toHaveLength(2);
  });

  test("only doctors are offered as Doctor and only nurses as Nurse", async ({ page }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));
    const staff = page.getByRole("region", { name: "Visit staff" });
    const doctorValues = await staff.getByLabel("Doctor", { exact: true }).locator("option").evaluateAll((o) =>
      o.map((e) => (e as HTMLOptionElement).value),
    );
    const nurseValues = await staff.getByLabel("Nurse", { exact: true }).locator("option").evaluateAll((o) =>
      o.map((e) => (e as HTMLOptionElement).value),
    );
    expect(doctorValues).toContain(user("doctor").userId);
    expect(doctorValues).not.toContain(user("nurse").userId);
    expect(nurseValues).toContain(user("nurse").userId);
    expect(nurseValues).not.toContain(user("doctor").userId);
  });

  test("admin sees it read-only; a closed visit is read-only for everyone", async ({ page }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "admin");
    await page.goto(visitUrl(visit));
    await expect(page.getByRole("region", { name: "Visit staff" }).getByLabel("Doctor", { exact: true })).toBeDisabled();

    await closeVisit(visit.visitId);
    await page.context().clearCookies();
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));
    await expect(page.getByRole("region", { name: "Visit staff" }).getByLabel("Nurse", { exact: true })).toBeDisabled();
  });
});
