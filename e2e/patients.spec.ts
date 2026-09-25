import { expect, test, type Page } from "@playwright/test";
import { loadActorContext } from "../src/modules/auth/service";
import { createPatient } from "../src/modules/patients/service";
import type { CreatePatientInput } from "../src/modules/patients/schema";
import { createVisitFixture, loginAs, uniq, user, visitUrl, withDb } from "./support";

/** R1a (ADR-028): persistent Patient Header, Patient Search, V1 patient form, Inactive. */

async function patientFixture(input: Omit<CreatePatientInput, "firstName" | "lastName"> & {
  firstName?: string;
  lastName?: string;
}): Promise<{ id: string; firstName: string; lastName: string }> {
  return withDb(async (db) => {
    const actor = await loadActorContext(db, user("doctor").userId);
    if (!actor) throw new Error("doctor actor not found");
    const s = uniq();
    const p = await createPatient(db, actor, {
      firstName: `First-${s}`,
      lastName: `Last-${s}`,
      ...input,
    });
    return { id: p.id, firstName: p.firstName, lastName: p.lastName };
  });
}

function header(page: Page) {
  return page.getByRole("region", { name: "Patient", exact: true });
}

async function openSearchDialog(page: Page) {
  await header(page).getByRole("button", { name: "Patient Search" }).click();
  const dialog = page.getByRole("dialog", { name: "Patient Search" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("Persistent Patient Header", () => {
  test("shows patient context on the visit screen without the legacy navigation row", async ({ page }) => {
    const s = uniq();
    const p = await patientFixture({ icareFileNo: `HDR-${s}`, sex: "F", dateOfBirth: "1980-01-15" });
    const { visitId } = await createVisitFixture({ patientId: p.id });

    await loginAs(page, "doctor");
    await page.goto(visitUrl({ patientId: p.id, visitId }));

    const h = header(page);
    await expect(h).toContainText(`HDR-${s}`);
    await expect(h).toContainText(`${p.lastName}, ${p.firstName}`);
    await expect(h).toContainText("Female");
    await expect(h).toContainText("1980-01-15");
    await expect(h.getByText(/^\d+$/).first()).toBeVisible(); // derived age
    await expect(h.getByRole("button", { name: "Create Report" })).toBeDisabled();
    await expect(h.getByRole("link", { name: "View Patient Chart" })).toBeVisible();
    await expect(h.getByRole("link", { name: "Create New Patient" })).toBeVisible();
    for (const legacy of ["Ext Demographics", "Contact Info", "Insurance Info", "Today's Charges", "Physicians"]) {
      await expect(page.getByText(legacy, { exact: true })).toHaveCount(0);
    }
    // Clinical tabs follow the header directly.
    await expect(page.getByRole("navigation", { name: "Clinical tabs" })).toBeVisible();
  });
});

test.describe("Patient Search", () => {
  test("finds patients sharing an Insurance ID and opens one by double-click, without criteria in the URL", async ({
    page,
  }) => {
    const s = uniq();
    const insuranceId = `INS-${s}`;
    const a = await patientFixture({ insuranceId, lastName: `Aaa-${s}` });
    const b = await patientFixture({ insuranceId, lastName: `Bbb-${s}` });
    const { visitId } = await createVisitFixture({ patientId: a.id });

    await loginAs(page, "reception");
    await page.goto(`/patients/${a.id}/visits/${visitId}`);
    const dialog = await openSearchDialog(page);
    await dialog.getByLabel("Insurance ID").fill(insuranceId);
    await dialog.getByLabel("Insurance ID").press("Enter");

    const rows = dialog.locator("table.search-results tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(dialog.getByRole("columnheader", { name: "MedicalID" })).toBeVisible();
    await expect(dialog.getByText("Double click on the patient you would like to select.")).toBeVisible();
    expect(page.url()).not.toContain(insuranceId);

    await rows.filter({ hasText: b.lastName }).dblclick();
    await page.waitForURL(`**/patients/${b.id}`);
    await expect(header(page)).toContainText(b.lastName);
  });

  test("opens with the recent patients, searches as you type, and takes the birthdate as day/month/year", async ({
    page,
  }) => {
    const s = uniq();
    const p = await patientFixture({ lastName: `Dob-${s}`, dateOfBirth: "1925-01-01" });
    await loginAs(page, "reception");
    await page.goto("/patients");

    // PS1: the list is already filled, newest change first.
    const rows = page.locator("table.search-results tbody tr");
    await expect(rows.first()).toContainText(p.lastName);
    await expect(page.getByRole("button", { name: "Search", exact: true })).toHaveCount(0);

    // PS4: day/month/year, with SonoSoft's example underneath.
    const dob = page.getByLabel("Birthdate");
    await expect(page.getByText("E.G. 01/01/1925")).toBeVisible();
    await dob.fill("31/02/1925");
    await expect(page.getByText("Birthdate must be day/month/year, e.g. 01/01/1925.")).toBeVisible();
    await dob.fill("01/01/1925");
    await page.getByLabel("Last Name").fill(`Dob-${s}`);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("1925-01-01");
    expect(page.url()).not.toContain("1925");
  });

  test("offers Create New Patient Record prefilled with the typed criteria", async ({ page }) => {
    const s = uniq();
    await loginAs(page, "reception");
    await page.getByLabel("Medical / File ID").fill(`NEW-${s}`);
    await page.getByLabel("Last Name").fill(`Newlast-${s}`);
    await page.getByLabel("First Name").fill(`Newfirst-${s}`);
    await page.getByLabel("Insurance ID").fill(`NINS-${s}`);
    // search as you type: no button needed (PS1)
    await expect(page.getByText("No patients matched your search.")).toBeVisible();
    await expect(page.getByText(/The data will be transferred to the Patient Demographic form/)).toBeVisible();

    await page.getByRole("button", { name: "Create a New Patient Record" }).click();
    await expect(page.getByLabel("File / Medical ID (iCare)")).toHaveValue(`NEW-${s}`);
    await expect(page.getByLabel("Last Name")).toHaveValue(`Newlast-${s}`);
    await expect(page.getByLabel("First Name")).toHaveValue(`Newfirst-${s}`);
    await expect(page.getByLabel("Insurance ID")).toHaveValue(`NINS-${s}`);

    await page.getByLabel("Sex").selectOption("M");
    await page.getByRole("button", { name: "Create patient" }).click();
    await page.waitForURL(/\/patients\/[0-9a-f-]{36}$/);
    await expect(header(page)).toContainText(`NEW-${s}`);
    await expect(header(page)).toContainText("Male");
  });
});

test.describe("Create / Edit Patient", () => {
  test("adds a Nationality with + Add New and keeps it on the patient", async ({ page }) => {
    const s = uniq();
    await loginAs(page, "reception");
    await page.goto("/patients/new");
    await page.getByLabel("First Name").fill(`Nat-${s}`);
    await page.getByLabel("Last Name").fill(`Ional-${s}`);
    await expect(page.getByLabel("Preferred Language").locator("option", { hasText: "Arabic" })).toHaveCount(1);
    await page.getByLabel("Preferred Language").selectOption({ label: "Arabic" });

    const nationality = page.getByLabel("Nationality / Race", { exact: true });
    await nationality.locator("..").getByRole("button", { name: "+ Add New" }).click();
    await page.getByLabel("New Nationality / Race option").fill(`Natland-${s}`);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(nationality.locator("option:checked")).toHaveText(`Natland-${s}`);

    await page.getByRole("button", { name: "Create patient" }).click();
    await page.waitForURL(/\/patients\/[0-9a-f-]{36}$/);
    await expect(header(page)).toContainText(`Natland-${s}`);
    await expect(page.getByLabel("Preferred Language").locator("option:checked")).toHaveText("Arabic");
  });
});

test.describe("Edit Patient", () => {
  test("saving the form updates the persistent header", async ({ page }) => {
    const s = uniq();
    const p = await patientFixture({ lastName: `Before-${s}` });
    await loginAs(page, "reception");
    await page.goto(`/patients/${p.id}`);
    await page.getByLabel("Last Name").fill(`After-${s}`);
    await page.getByLabel("File / Medical ID (iCare)").fill(`EDIT-${s}`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Patient details saved.")).toBeVisible();
    await expect(header(page)).toContainText(`After-${s}`);
    await expect(header(page)).toContainText(`EDIT-${s}`);
  });
});

test.describe("Inactive Patient", () => {
  test("only Admin can mark a patient inactive; inactive patients get no new visits and are hidden by default", async ({
    page,
    browser,
  }) => {
    const s = uniq();
    const p = await patientFixture({ lastName: `Inact-${s}` });

    await loginAs(page, "reception");
    await page.goto(`/patients/${p.id}`);
    await expect(page.getByRole("button", { name: "Mark patient inactive" })).toHaveCount(0);

    const adminContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      await loginAs(adminPage, "admin");
      await adminPage.goto(`/patients/${p.id}`);
      await adminPage.getByRole("button", { name: "Mark patient inactive" }).click();
      await expect(adminPage.getByRole("button", { name: "Reactivate patient" })).toBeVisible();
      await expect(header(adminPage).getByText("Inactive")).toBeVisible();
    } finally {
      await adminContext.close();
    }

    await page.reload();
    await expect(page.getByRole("button", { name: "New visit" })).toHaveCount(0);
    await expect(page.getByText(/must reactivate the patient/)).toBeVisible();

    await page.goto("/patients");
    await page.getByLabel("Last Name").fill(`Inact-${s}`);
    await expect(page.getByText("No patients matched your search.")).toBeVisible();
    await page.getByLabel("Include inactive").check();
    await expect(page.locator("table.search-results tbody tr")).toHaveCount(1);
  });
});
