import { expect, test, type Page } from "@playwright/test";
import {
  createVisitFixture,
  discardDialog,
  entryHistory,
  field,
  loginAs,
  statusOf,
  uniq,
  unsavedBanner,
  visitUrl,
  type VisitFixture,
} from "./support";

// Order from docs/CLINICAL_TABS.md.
const TABS = ["Subj Complaints Habits", "Past Medical Hx", "Assessment Plan+"];

const SUBJ_ORDER = [
  "Reason for Visit",
  "Problem List",
  "Chief Complaints",
  "Characteristics",
  "Duration",
  "Progression",
  "Daily Activity Impact",
  "Chest Comments",
  "Comments",
  "Aggravating Factors",
  "Relieving Factors",
  "Previous Conservative Therapy",
  "Previous Conservative Therapy Duration",
  "Family History",
  "Alcohol",
  "Exercise",
  "Tobacco",
  "Pain Meds",
  "Current Meds",
  "Allergies",
];
// The female-specific field is deferred (ADR-027) and must not appear.
const PMH_ORDER = [
  "Past Medical Hx",
  "Family Medical Hx",
  "Unknown",
  "Prior Test Results",
  "Additional Comments",
  "Surgical Hx",
];
const ASSESSMENT_ORDER = [
  "Impression",
  "Recommendations",
  "Stockings Type",
  "Stockings Compression",
  "Stockings Gender",
  "Stockings Color",
  "Stockings Measurements",
  "Additional Comments",
];

const PMH_TAB = "past_medical_hx";
const ASSESSMENT_TAB = "assessment_plan";

const tabsNav = (page: Page) => page.getByRole("navigation", { name: "Clinical tabs" });
const fieldLabels = (page: Page) => page.locator(".clinical-field .field-head label");
const tabUrl = (v: VisitFixture, code: string) => `${visitUrl(v)}?tab=${code}`;
const SAVE_API = "**/api/visits/*/clinical-entries/*";

/** Adds a permanent option through "+ Add New" (which also selects it) and waits for the save. */
async function addOption(page: Page, code: string, label: string, name: string): Promise<void> {
  const f = field(page, code);
  await f.getByLabel(`New ${name} option`).fill(label);
  await f.getByRole("button", { name: "+ Add New" }).click();
  await expect(statusOf(page, code)).toHaveText("Saved");
}

test.describe("Sprint 3A tabs: Past Medical Hx and Assessment Plan+", () => {
  test("tabs come from data in docs order; each tab renders ONLY its own form with fields in exact order", async ({
    page,
  }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));

    await expect(tabsNav(page).locator(".tab")).toHaveText(TABS);
    await expect(tabsNav(page).locator(".tab.active")).toHaveText("Subj Complaints Habits");
    await expect(fieldLabels(page)).toHaveText(SUBJ_ORDER); // Subj unchanged
    await expect(page.locator(".clinical-form")).toHaveCount(1);

    await tabsNav(page).getByRole("link", { name: "Past Medical Hx" }).click();
    await expect(page).toHaveURL(tabUrl(visit, PMH_TAB));
    await expect(tabsNav(page).locator(".tab.active")).toHaveText("Past Medical Hx");
    await expect(fieldLabels(page)).toHaveText(PMH_ORDER);
    await expect(page.locator(".clinical-form")).toHaveCount(1);
    await expect(page.locator("[data-field]")).toHaveCount(PMH_ORDER.length);
    await expect(page.getByText(/female|gyn|pregnan/i)).toHaveCount(0);

    await tabsNav(page).getByRole("link", { name: "Assessment Plan+" }).click();
    await expect(page).toHaveURL(tabUrl(visit, ASSESSMENT_TAB));
    await expect(fieldLabels(page)).toHaveText(ASSESSMENT_ORDER);
    await expect(page.locator("[data-field]")).toHaveCount(ASSESSMENT_ORDER.length);

    await tabsNav(page).getByRole("link", { name: "Subj Complaints Habits" }).click();
    await expect(fieldLabels(page)).toHaveText(SUBJ_ORDER);
    await expect(page.locator("[data-field]")).toHaveCount(SUBJ_ORDER.length);
  });

  test("an unknown tab is a 404, never a silent fallback", async ({ page }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "doctor");
    const res = await page.goto(tabUrl(visit, "not_a_tab"));
    expect(res?.status()).toBe(404);
  });

  test("Past Medical Hx values persist across a reload (options, free text, textareas)", async ({ page }) => {
    const visit = await createVisitFixture();
    const s = uniq();
    await loginAs(page, "doctor");
    await page.goto(tabUrl(visit, PMH_TAB));

    await addOption(page, "past_medical_history", `Hypertension ${s}`, "Past Medical Hx");
    await field(page, "past_medical_history")
      .getByLabel("Past Medical Hx — visit-only free text")
      .fill(`only today ${s}`);
    await expect(statusOf(page, "past_medical_history")).toHaveText("Saved");
    await addOption(page, "surgical_history", `Appendectomy ${s}`, "Surgical Hx");
    await field(page, "prior_test_results").locator("textarea").fill(`Duplex normal ${s}`);
    await expect(statusOf(page, "prior_test_results")).toHaveText("Saved");
    await field(page, "past_medical_additional_comments").locator("textarea").fill(`PMH note ${s}`);
    await expect(statusOf(page, "past_medical_additional_comments")).toHaveText("Saved");

    await page.reload();
    await expect(
      field(page, "past_medical_history").getByRole("checkbox", { name: `Hypertension ${s}` }),
    ).toBeChecked();
    await expect(field(page, "past_medical_history").getByLabel("Past Medical Hx — visit-only free text")).toHaveValue(
      `only today ${s}`,
    );
    await expect(field(page, "surgical_history").getByRole("checkbox", { name: `Appendectomy ${s}` })).toBeChecked();
    await expect(field(page, "prior_test_results").locator("textarea")).toHaveValue(`Duplex normal ${s}`);
    await expect(field(page, "past_medical_additional_comments").locator("textarea")).toHaveValue(
      `PMH note ${s}`,
    );
  });

  test("Assessment Plan+ persists: Impression/Recommendations options + free text; the two Additional Comments stay separate", async ({
    page,
  }) => {
    const visit = await createVisitFixture();
    const s = uniq();
    await loginAs(page, "doctor");
    await page.goto(tabUrl(visit, ASSESSMENT_TAB));

    await addOption(page, "impression", `Great saphenous reflux ${s}`, "Impression");
    await field(page, "impression").getByLabel("Impression — visit-only free text").fill(`right leg ${s}`);
    await expect(statusOf(page, "impression")).toHaveText("Saved");
    await addOption(page, "recommendations", `Ablation ${s}`, "Recommendations");
    await field(page, "assessment_additional_comments").locator("textarea").fill(`assessment note ${s}`);
    await expect(statusOf(page, "assessment_additional_comments")).toHaveText("Saved");

    await page.reload();
    await expect(field(page, "impression").getByRole("checkbox", { name: `Great saphenous reflux ${s}` })).toBeChecked();
    // lists are independent: Recommendations does not offer Impression's option
    await expect(field(page, "recommendations").getByRole("checkbox", { name: `Great saphenous reflux ${s}` })).toHaveCount(0);
    await expect(field(page, "recommendations").getByRole("checkbox", { name: `Ablation ${s}` })).toBeChecked();
    await expect(field(page, "assessment_additional_comments").locator("textarea")).toHaveValue(
      `assessment note ${s}`,
    );

    await page.goto(tabUrl(visit, PMH_TAB));
    await expect(field(page, "past_medical_additional_comments").locator("textarea")).toHaveValue("");
    expect(await entryHistory(visit.visitId, "past_medical_additional_comments")).toHaveLength(0);
  });

  test("Family Medical Hx is the same field as Family History: one history, visible and editable from both tabs", async ({
    page,
  }) => {
    const visit = await createVisitFixture();
    const s = uniq();
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));

    await addOption(page, "family_history", `Mother DVT ${s}`, "Family History");
    await tabsNav(page).getByRole("link", { name: "Past Medical Hx" }).click();
    const inPmh = field(page, "family_history");
    await expect(inPmh.locator("label").first()).toHaveText("Family Medical Hx");
    await expect(inPmh.getByRole("checkbox", { name: `Mother DVT ${s}` })).toBeChecked();

    await inPmh.getByLabel("Family Medical Hx — visit-only free text").fill(`sister too ${s}`);
    await expect(statusOf(page, "family_history")).toHaveText("Saved");

    await tabsNav(page).getByRole("link", { name: "Subj Complaints Habits" }).click();
    const inSubj = field(page, "family_history");
    await expect(inSubj.locator("label").first()).toHaveText("Family History");
    await expect(inSubj.getByLabel("Family History — visit-only free text")).toHaveValue(`sister too ${s}`);

    const history = await entryHistory(visit.visitId, "family_history");
    expect(history.map((r) => r.version)).toEqual([1, 2]); // one stream, no duplicate source
  });

  test("Stockings fields are independent: saving one creates nothing for the others and copies no demographics", async ({
    page,
  }) => {
    const visit = await createVisitFixture();
    const s = uniq();
    await loginAs(page, "doctor");
    await page.goto(tabUrl(visit, ASSESSMENT_TAB));

    await addOption(page, "stockings_type", `Thigh-high ${s}`, "Stockings Type");
    await field(page, "stockings_measurements").locator("textarea").fill(`ankle 22 / calf 36 ${s}`);
    await expect(statusOf(page, "stockings_measurements")).toHaveText("Saved");

    for (const code of ["stockings_compression", "stockings_gender", "stockings_color"]) {
      await expect(field(page, code).getByRole("combobox")).toHaveValue("");
      await expect(statusOf(page, code)).toHaveText("");
    }
    await page.reload();
    await expect(field(page, "stockings_type").getByRole("combobox").locator("option:checked")).toHaveText(
      `Thigh-high ${s}`,
    );
    await expect(field(page, "stockings_gender").getByRole("combobox")).toHaveValue("");

    expect(await entryHistory(visit.visitId, "stockings_type")).toHaveLength(1);
    expect(await entryHistory(visit.visitId, "stockings_measurements")).toHaveLength(1);
    for (const code of ["stockings_compression", "stockings_gender", "stockings_color"]) {
      expect(await entryHistory(visit.visitId, code), code).toHaveLength(0);
    }
  });

  test('"Unknown" excludes Past Medical Hx in the UI (disable only, nothing cleared for the user) and survives a reload', async ({
    page,
  }) => {
    const visit = await createVisitFixture();
    const s = uniq();
    await loginAs(page, "doctor");
    await page.goto(tabUrl(visit, PMH_TAB));

    const pmh = field(page, "past_medical_history");
    const unknown = field(page, "past_medical_unknown").getByRole("checkbox", { name: "Unknown" });

    // Past Medical Hx has a value -> Unknown cannot be checked until it is cleared.
    await addOption(page, "past_medical_history", `Asthma ${s}`, "Past Medical Hx");
    await expect(unknown).toBeDisabled();
    await expect(field(page, "past_medical_unknown")).toContainText("Clear Past Medical Hx");

    await pmh.getByRole("checkbox", { name: `Asthma ${s}` }).uncheck();
    await expect(statusOf(page, "past_medical_history")).toHaveText("Saved");
    await expect(unknown).toBeEnabled();

    await unknown.check();
    await expect(statusOf(page, "past_medical_unknown")).toHaveText("Saved");
    // Past Medical Hx is now unavailable, including free text and + Add New.
    await expect(pmh.getByRole("checkbox", { name: `Asthma ${s}` })).toBeDisabled();
    await expect(pmh.getByLabel("Past Medical Hx — visit-only free text")).toBeDisabled();
    await expect(pmh.getByRole("button", { name: "+ Add New" })).toHaveCount(0);
    await expect(pmh).toContainText("Uncheck Unknown");
    // Other Past Medical Hx fields are not affected.
    await expect(field(page, "surgical_history").getByLabel("Surgical Hx — visit-only free text")).toBeEnabled();
    await expect(field(page, "prior_test_results").locator("textarea")).toBeEnabled();

    await page.reload();
    await expect(unknown).toBeChecked();
    await expect(pmh.getByLabel("Past Medical Hx — visit-only free text")).toBeDisabled();

    await unknown.uncheck();
    await expect(statusOf(page, "past_medical_unknown")).toHaveText("Saved");
    await expect(pmh.getByLabel("Past Medical Hx — visit-only free text")).toBeEnabled();

    const history = await entryHistory(visit.visitId, "past_medical_unknown");
    expect(history.map((r) => r.checked)).toEqual([true, false]);
    // The user cleared Past Medical Hx themselves; nothing was rewritten silently.
    expect((await entryHistory(visit.visitId, "past_medical_history")).map((r) => r.optionIds.length)).toEqual([1, 0]);
  });

  test("a stale page cannot bypass the exclusion: the server refuses, the text stays, nothing is saved", async ({
    page,
    browser,
  }) => {
    const visit = await createVisitFixture();
    const otherCtx = await browser.newContext();
    const stale = await otherCtx.newPage();
    try {
      await loginAs(page, "doctor");
      await loginAs(stale, "doctor2");
      await page.goto(tabUrl(visit, PMH_TAB));
      await stale.goto(tabUrl(visit, PMH_TAB));
      // The stale page must not learn about the change (no fresh-state reconcile).
      await stale.route("**/api/visits/*/clinical-sections/*", (route) => route.abort("failed"));

      await field(page, "past_medical_unknown").getByRole("checkbox", { name: "Unknown" }).check();
      await expect(statusOf(page, "past_medical_unknown")).toHaveText("Saved");

      const box = field(stale, "past_medical_history").getByLabel("Past Medical Hx — visit-only free text");
      await expect(box).toBeEnabled();
      await box.pressSequentially("hypertension");
      await expect(statusOf(stale, "past_medical_history")).toHaveText("Not saved");
      await expect(field(stale, "past_medical_history")).toContainText("cannot have values while");
      await expect(unsavedBanner(stale)).toContainText("not saved yet");
      await expect(box).toHaveValue("hypertension");
      expect(await entryHistory(visit.visitId, "past_medical_history")).toHaveLength(0);
    } finally {
      await otherCtx.close();
    }
  });

  test("switching tabs keeps the unsaved-navigation protection", async ({ page }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "doctor");
    await page.goto(tabUrl(visit, PMH_TAB));

    await page.route(SAVE_API, (route) => route.abort("failed"));
    const box = field(page, "prior_test_results").locator("textarea");
    await box.pressSequentially("unsaved lab result");
    await expect(statusOf(page, "prior_test_results")).toHaveText("Not saved");

    // The tab link is guarded: an explicit choice is required.
    await tabsNav(page).getByRole("link", { name: "Assessment Plan+" }).click();
    const dialog = discardDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Prior Test Results");
    await dialog.getByRole("button", { name: "Stay on page" }).click();
    await expect(page).toHaveURL(tabUrl(visit, PMH_TAB));
    await expect(box).toHaveValue("unsaved lab result");

    // Once the save can succeed, leaving needs no prompt and nothing is lost.
    await page.unroute(SAVE_API);
    await field(page, "prior_test_results").getByRole("button", { name: "Retry save" }).click();
    await expect(statusOf(page, "prior_test_results")).toHaveText("Saved");
    await tabsNav(page).getByRole("link", { name: "Assessment Plan+" }).click();
    await expect(page).toHaveURL(tabUrl(visit, ASSESSMENT_TAB));
    await expect(discardDialog(page)).toHaveCount(0);
    expect((await entryHistory(visit.visitId, "prior_test_results")).map((r) => r.freeText)).toEqual([
      "unsaved lab result",
    ]);

    await tabsNav(page).getByRole("link", { name: "Past Medical Hx" }).click();
    await expect(field(page, "prior_test_results").locator("textarea")).toHaveValue("unsaved lab result");
  });

  test("explicit discard is the only way to lose text when switching tabs; a pending edit is flushed by the switch itself", async ({
    page,
  }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "doctor");
    await page.goto(tabUrl(visit, ASSESSMENT_TAB));

    // Pending (not failed): flushed by the navigation, no prompt.
    await field(page, "stockings_measurements").locator("textarea").pressSequentially("thigh 50 cm");
    await tabsNav(page).getByRole("link", { name: "Past Medical Hx" }).click();
    await expect(page).toHaveURL(tabUrl(visit, PMH_TAB));
    await expect(discardDialog(page)).toHaveCount(0);
    expect((await entryHistory(visit.visitId, "stockings_measurements")).map((r) => r.freeText)).toEqual([
      "thigh 50 cm",
    ]);

    // Failed: blocked until the user explicitly discards.
    await page.route(SAVE_API, (route) => route.abort("failed"));
    await field(page, "past_medical_additional_comments").locator("textarea").pressSequentially("lost on purpose");
    await expect(statusOf(page, "past_medical_additional_comments")).toHaveText("Not saved");
    await tabsNav(page).getByRole("link", { name: "Assessment Plan+" }).click();
    await expect(discardDialog(page)).toBeVisible();
    await discardDialog(page).getByRole("button", { name: "Discard unsaved text and leave" }).click();
    await expect(page).toHaveURL(tabUrl(visit, ASSESSMENT_TAB));
    await page.unroute(SAVE_API);
    expect(await entryHistory(visit.visitId, "past_medical_additional_comments")).toHaveLength(0);
  });

  test("permissions on the new tabs: nurse has no + Add New but can write and use Unknown; admin is read-only; reception has no tabs", async ({
    page,
    browser,
  }) => {
    const visit = await createVisitFixture();

    await loginAs(page, "nurse");
    await page.goto(tabUrl(visit, PMH_TAB));
    await expect(tabsNav(page).locator(".tab")).toHaveText(TABS);
    await expect(page.getByRole("button", { name: "+ Add New" })).toHaveCount(0);
    await field(page, "prior_test_results").locator("textarea").fill("nurse entry");
    await expect(statusOf(page, "prior_test_results")).toHaveText("Saved");
    await field(page, "past_medical_unknown").getByRole("checkbox", { name: "Unknown" }).check();
    await expect(statusOf(page, "past_medical_unknown")).toHaveText("Saved");
    await page.goto(tabUrl(visit, ASSESSMENT_TAB));
    await expect(page.getByRole("button", { name: "+ Add New" })).toHaveCount(0);
    await field(page, "impression").getByLabel("Impression — visit-only free text").fill("nurse wording");
    await expect(statusOf(page, "impression")).toHaveText("Saved");

    const adminCtx = await browser.newContext();
    const receptionCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    const receptionPage = await receptionCtx.newPage();
    try {
      await loginAs(adminPage, "admin");
      await adminPage.goto(tabUrl(visit, PMH_TAB));
      await expect(adminPage.getByText("read-only access")).toBeVisible();
      await expect(field(adminPage, "prior_test_results").locator("textarea")).toBeDisabled();
      await expect(field(adminPage, "past_medical_unknown").getByRole("checkbox", { name: "Unknown" })).toBeDisabled();
      await adminPage.goto(tabUrl(visit, ASSESSMENT_TAB));
      await expect(field(adminPage, "assessment_additional_comments").locator("textarea")).toBeDisabled();

      await loginAs(receptionPage, "reception");
      await receptionPage.goto(tabUrl(visit, PMH_TAB));
      await expect(receptionPage.getByText("You do not have access to clinical entries.")).toBeVisible();
      await expect(tabsNav(receptionPage)).toHaveCount(0);
      await expect(receptionPage.locator("[data-field]")).toHaveCount(0);
    } finally {
      await adminCtx.close();
      await receptionCtx.close();
    }
    expect((await entryHistory(visit.visitId, "prior_test_results")).map((r) => r.freeText)).toEqual(["nurse entry"]);
  });
});
