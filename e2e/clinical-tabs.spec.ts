import { expect, test, type Page } from "@playwright/test";
import {
  createVisitFixture,
  discardDialog,
  entryHistory,
  field,
  loginAs,
  newOptionInput,
  openList,
  statusOf,
  uniq,
  unsavedBanner,
  visitUrl,
  type VisitFixture,
} from "./support";

// Order from docs/CLINICAL_TABS.md.
const TABS = ["Subj Complaints Habits", "Past Medical Hx", "Assessment Plan+"];

// SonoSoft order (docs/CLINICAL_TABS.md, docs/reference/sonosoft/tabs/, ADR-029), by field code.
const SUBJ_CODES = [
  "reason_for_visit",
  "problem_list",
  "chief_complaints",
  "characteristics",
  "duration",
  "symptoms_worse",
  "progression",
  "daily_activity_impact",
  "chest_comments",
  "comments",
  "aggravating_factors",
  "relieving_factors",
  "previous_conservative_therapy",
  "previous_conservative_therapy_duration",
  "family_history_vv",
  "alcohol",
  "exercise",
  "tobacco",
  "pain_meds",
  "current_meds",
  "current_meds_none",
  "allergies",
  "allergies_no_known",
];
const PMH_CODES = [
  "past_medical_history",
  "family_history",
  "family_history_unknown",
  "prior_test_results",
  "past_medical_additional_comments",
  "surgical_history",
  "female_statement",
];
const rows = (prefix: string) => Array.from({ length: 8 }, (_, i) => `${prefix}_${i + 1}`);
// Impression rows are shown 1-4 | 5-8 side by side, like SonoSoft.
const ASSESSMENT_CODES = [
  "impression_list_style",
  "impression_1",
  "impression_5",
  "impression_2",
  "impression_6",
  "impression_3",
  "impression_7",
  "impression_4",
  "impression_8",
  "impr_for_init_venous_interp",
  ...rows("recommendation"),
  "stockings_type",
  "stockings_compression",
  "stockings_gender",
  "stockings_color",
  "stockings_mid_thigh",
  "stockings_mid_calf",
  "stockings_mid_ankle",
  "stockings_floor_to_gf",
  "stockings_floor_to_knee",
  "assessment_additional_comments",
];

const PMH_TAB = "past_medical_hx";
const ASSESSMENT_TAB = "assessment_plan";

const tabsNav = (page: Page) => page.getByRole("navigation", { name: "Clinical tabs" });

/**
 * The three documented tabs, in order. Tabs are data, and the Vitest step of CI
 * shares its database with this suite (clinical-definitions tests leave extra
 * sections such as "A later tab" behind), so foreign tabs are ignored here.
 */
async function expectDocumentedTabs(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      (await tabsNav(page).locator(".tab").allTextContents()).filter((t) => TABS.includes(t.trim())),
    )
    .toEqual(TABS);
}
const fieldCodes = (page: Page) =>
  page.locator("[data-field]").evaluateAll((els) => els.map((e) => e.getAttribute("data-field")));
const tabUrl = (v: VisitFixture, code: string) => `${visitUrl(v)}?tab=${code}`;
const SAVE_API = "**/api/visits/*/clinical-entries/*";

/** Adds a permanent option through "+ Add New" (which also selects it) and waits for the save. */
async function addOption(page: Page, code: string, label: string, name: string): Promise<void> {
  const f = field(page, code);
  await (await newOptionInput(page, code, name)).fill(label);
  await f.getByRole("button", { name: "+ Add New" }).click();
  await expect(statusOf(page, code)).toHaveText("Saved");
}

test.describe("Sprint 3A tabs: Past Medical Hx and Assessment Plan+", () => {
  test("tabs come from data in docs order; each tab renders ONLY its own form with fields in SonoSoft order", async ({
    page,
  }) => {
    const visit = await createVisitFixture({ sex: "F" });
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));

    await expectDocumentedTabs(page);
    await expect(tabsNav(page).locator(".tab.active")).toHaveText("Subj Complaints Habits");
    await expect.poll(() => fieldCodes(page)).toEqual(SUBJ_CODES);
    await expect(page.locator(".clinical-form")).toHaveCount(1);
    // SonoSoft wording, shown next to each control (drawn at SonoSoft's positions).
    const labelFor = (code: string) => page.locator(`label[for="field-${code}"]`);
    await expect(labelFor("reason_for_visit")).toHaveText("Reason for visit");
    await expect(field(page, "characteristics").getByRole("textbox")).toHaveAttribute("placeholder", "associated with");
    await expect(labelFor("previous_conservative_therapy_duration")).toHaveText("How long?");
    await expect(page.getByRole("button", { name: "Problem List" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add Chief Complaints with characteristics and Associated conditions" }),
    ).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Symptoms getting worse over time?" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "None", exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "No known" })).toBeVisible();
    await expect(page.getByText("Habits", { exact: true })).toBeVisible();

    await tabsNav(page).getByRole("link", { name: "Past Medical Hx" }).click();
    await expect(page).toHaveURL(tabUrl(visit, PMH_TAB));
    await expect(tabsNav(page).locator(".tab.active")).toHaveText("Past Medical Hx");
    await expect.poll(() => fieldCodes(page)).toEqual(PMH_CODES);
    await expect(page.locator(".clinical-form")).toHaveCount(1);
    await expect(page.getByText("Click to Add")).toBeVisible();
    for (const opener of ["Past Medical Hx", "Family Medical Hx", "Prior Test Results", "Surgical Hx"]) {
      await expect(page.getByRole("button", { name: opener, exact: true })).toBeVisible();
    }

    await tabsNav(page).getByRole("link", { name: "Assessment Plan+" }).click();
    await expect(page).toHaveURL(tabUrl(visit, ASSESSMENT_TAB));
    await expect.poll(() => fieldCodes(page)).toEqual(ASSESSMENT_CODES);
    for (const title of ["Impression", "Recommendations", "Stockings detail"]) {
      await expect(page.getByText(title, { exact: true })).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Select Impressions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Select Recomendations" })).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Bullets / Numbers" })).toBeVisible();

    await tabsNav(page).getByRole("link", { name: "Subj Complaints Habits" }).click();
    await expect.poll(() => fieldCodes(page)).toEqual(SUBJ_CODES);
  });

  test("an unknown tab is a 404, never a silent fallback", async ({ page }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "doctor");
    const res = await page.goto(tabUrl(visit, "not_a_tab"));
    expect(res?.status()).toBe(404);
  });

  test("Past Medical Hx values persist across a reload (options, free text, textarea, Additional Comments list)", async ({
    page,
  }) => {
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
    // P3: Additional Comments is a dropdown with free text, like SonoSoft.
    await addOption(page, "past_medical_additional_comments", `See old file ${s}`, "Additional Comments");
    // Typing after the chosen option adds visit-only text, as in SonoSoft's combo box.
    await field(page, "past_medical_additional_comments")
      .getByRole("combobox")
      .fill(`See old file ${s}, PMH note ${s}`);
    await expect(statusOf(page, "past_medical_additional_comments")).toHaveText("Saved");

    await page.reload();
    await expect(field(page, "past_medical_history")).toContainText(`Hypertension ${s}`);
    await openList(page, "past_medical_history", "Past Medical Hx");
    await expect(
      field(page, "past_medical_history").getByRole("checkbox", { name: `Hypertension ${s}` }),
    ).toBeChecked();
    await expect(field(page, "past_medical_history").getByLabel("Past Medical Hx — visit-only free text")).toHaveValue(
      `only today ${s}`,
    );
    await expect(field(page, "surgical_history")).toContainText(`Appendectomy ${s}`);
    await expect(field(page, "prior_test_results").locator("textarea")).toHaveValue(`Duplex normal ${s}`);
    const comments = field(page, "past_medical_additional_comments");
    await expect(comments.getByRole("combobox")).toHaveValue(`See old file ${s}, PMH note ${s}`);
    const last = (await entryHistory(visit.visitId, "past_medical_additional_comments")).at(-1);
    expect(last?.optionIds).toHaveLength(1);
    expect(last?.freeText).toBe(`PMH note ${s}`);
  });

  test("Assessment Plan+ rows: one list per concept, Select Impressions fills the next empty row, rows persist in order", async ({
    page,
  }) => {
    const visit = await createVisitFixture();
    const s = uniq();
    await loginAs(page, "doctor");
    await page.goto(tabUrl(visit, ASSESSMENT_TAB));

    // "+ Add New" on row 1 adds to the shared Impression list and selects it there.
    await addOption(page, "impression_1", `Great saphenous reflux ${s}`, "Impression 1");
    await addOption(page, "impression_2", `Perforator reflux ${s}`, "Impression 2");
    const filler = page.getByRole("button", { name: "Select Impressions" });
    await filler.click();
    await expect(page.getByText("→ row 3")).toBeVisible();
    await page
      .getByRole("listbox", { name: "Select Impressions" })
      .getByRole("option", { name: `Great saphenous reflux ${s}` })
      .click();
    await expect(statusOf(page, "impression_3")).toHaveText("Saved");
    await filler.click();
    await expect(page.getByText("→ row 4")).toBeVisible();
    await page.keyboard.press("Escape");
    await field(page, "impression_3").getByRole("combobox").fill(`Great saphenous reflux ${s}, right leg ${s}`);
    await expect(statusOf(page, "impression_3")).toHaveText("Saved");

    await page.getByRole("radiogroup", { name: "Bullets / Numbers" }).getByRole("radio", { name: "Numbers" }).check();
    await expect(statusOf(page, "impression_list_style")).toHaveText("Saved");

    await addOption(page, "recommendation_1", `Ablation ${s}`, "Recommendation 1");
    await field(page, "assessment_additional_comments").locator("textarea").fill(`assessment note ${s}`);
    await expect(statusOf(page, "assessment_additional_comments")).toHaveText("Saved");

    await page.reload();
    const combo = (code: string) => field(page, code).getByRole("combobox");
    await expect(combo("impression_1")).toHaveValue(`Great saphenous reflux ${s}`);
    await expect(combo("impression_2")).toHaveValue(`Perforator reflux ${s}`);
    await expect(combo("impression_3")).toHaveValue(`Great saphenous reflux ${s}, right leg ${s}`);
    await expect(field(page, "impression_4").getByRole("combobox")).toHaveValue("");
    await expect(page.getByRole("radio", { name: "Numbers" })).toBeChecked();
    await expect(combo("recommendation_1")).toHaveValue(`Ablation ${s}`);
    // Lists are independent: Recommendations does not offer Impression's option.
    await openList(page, "recommendation_2", "Recommendation 2");
    await expect(field(page, "recommendation_2").getByRole("option", { name: `Ablation ${s}` })).toBeVisible();
    await expect(
      field(page, "recommendation_2").getByRole("option", { name: `Great saphenous reflux ${s}` }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(field(page, "assessment_additional_comments").locator("textarea")).toHaveValue(
      `assessment note ${s}`,
    );
    expect((await entryHistory(visit.visitId, "impression_list_style")).map((r) => r.freeText)).toEqual(["numbers"]);
    expect(await entryHistory(visit.visitId, "impression_5")).toHaveLength(0);
  });

  test("S1: Subj asks Family history of VV?; the general Family Medical Hx lives only in Past Medical Hx", async ({
    page,
  }) => {
    const visit = await createVisitFixture();
    const s = uniq();
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));

    await expect(field(page, "family_history")).toHaveCount(0);
    await addOption(page, "family_history_vv", `Mother ${s}`, "Family history of VV?");

    await tabsNav(page).getByRole("link", { name: "Past Medical Hx" }).click();
    await expect(field(page, "family_history_vv")).toHaveCount(0);
    await addOption(page, "family_history", `Mother DVT ${s}`, "Family Medical Hx");

    await page.reload();
    await expect(field(page, "family_history")).toContainText(`Mother DVT ${s}`);
    expect(await entryHistory(visit.visitId, "family_history_vv")).toHaveLength(1);
    expect(await entryHistory(visit.visitId, "family_history")).toHaveLength(1);
  });

  test("Stockings: separate numeric measurements in cm; invalid numbers are refused; saving one creates nothing for the others", async ({
    page,
  }) => {
    const visit = await createVisitFixture();
    const s = uniq();
    await loginAs(page, "doctor");
    await page.goto(tabUrl(visit, ASSESSMENT_TAB));

    await addOption(page, "stockings_type", `Thigh-high ${s}`, "Type");
    await expect(field(page, "stockings_mid_calf")).toContainText("cm");
    await field(page, "stockings_mid_calf").getByLabel("Mid Calf").fill("36.5");
    await expect(statusOf(page, "stockings_mid_calf")).toHaveText("Saved");
    await field(page, "stockings_floor_to_gf").getByLabel("Floor To GF").fill("abc");
    await expect(statusOf(page, "stockings_floor_to_gf")).toHaveText("Not saved");
    await expect(field(page, "stockings_floor_to_gf")).toContainText("must be a number");
    await field(page, "stockings_floor_to_gf").getByLabel("Floor To GF").fill("");
    await expect(statusOf(page, "stockings_floor_to_gf")).not.toHaveText("Not saved");

    for (const code of ["stockings_compression", "stockings_gender", "stockings_color"]) {
      await expect(field(page, code).getByRole("combobox")).toHaveValue("");
      await expect(statusOf(page, code)).toHaveText("");
    }
    await page.reload();
    await expect(field(page, "stockings_type").getByRole("combobox")).toHaveValue(`Thigh-high ${s}`);
    await expect(field(page, "stockings_mid_calf").getByLabel("Mid Calf")).toHaveValue("36.5");

    expect(await entryHistory(visit.visitId, "stockings_type")).toHaveLength(1);
    expect((await entryHistory(visit.visitId, "stockings_mid_calf")).map((r) => r.freeText)).toEqual(["36.5"]);
    for (const code of [
      "stockings_compression",
      "stockings_gender",
      "stockings_color",
      "stockings_mid_thigh",
      "stockings_floor_to_gf",
    ]) {
      expect(await entryHistory(visit.visitId, code), code).toHaveLength(0);
    }
  });

  test("P2: the female statement is only available for a female patient", async ({ page }) => {
    const male = await createVisitFixture({ sex: "M" });
    const female = await createVisitFixture({ sex: "F" });
    const s = uniq();
    await loginAs(page, "doctor");

    await page.goto(tabUrl(male, PMH_TAB));
    const locked = field(page, "female_statement");
    await expect(locked.getByRole("combobox")).toBeDisabled();
    await expect(locked).toContainText("For female patients only.");
    await expect(locked.getByRole("button", { name: /^Open .* list$/ })).toBeDisabled();

    await page.goto(tabUrl(female, PMH_TAB));
    const open = field(page, "female_statement");
    await expect(open.getByRole("combobox")).toBeEnabled();
    await addOption(page, "female_statement", `Not pregnant ${s}`, "If FEMALE select the appropriate statement; otherwise disregard");
    expect(await entryHistory(female.visitId, "female_statement")).toHaveLength(1);
    expect(await entryHistory(male.visitId, "female_statement")).toHaveLength(0);
  });

  test('"Unknown" excludes Family Medical Hx in the UI (disable only, nothing cleared for the user) and survives a reload', async ({
    page,
  }) => {
    const visit = await createVisitFixture();
    const s = uniq();
    await loginAs(page, "doctor");
    await page.goto(tabUrl(visit, PMH_TAB));

    const family = field(page, "family_history");
    const unknown = field(page, "family_history_unknown").getByRole("checkbox", { name: "Unknown" });

    // Family Medical Hx has a value -> Unknown cannot be checked until it is cleared.
    await addOption(page, "family_history", `Sister ${s}`, "Family Medical Hx");
    await expect(unknown).toBeDisabled();
    await expect(field(page, "family_history_unknown")).toContainText("Clear Family Medical Hx");

    await openList(page, "family_history", "Family Medical Hx");
    await family.getByRole("checkbox", { name: `Sister ${s}` }).uncheck();
    await expect(statusOf(page, "family_history")).toHaveText("Saved");
    await expect(unknown).toBeEnabled();

    await unknown.check();
    await expect(statusOf(page, "family_history_unknown")).toHaveText("Saved");
    // Family Medical Hx is now unavailable, including free text and + Add New.
    await page.getByRole("button", { name: "Family Medical Hx", exact: true }).click();
    await expect(family.getByRole("checkbox", { name: `Sister ${s}` })).toBeDisabled();
    await expect(family.getByLabel("Family Medical Hx — visit-only free text")).toBeDisabled();
    await expect(family.getByRole("button", { name: "+ Add New" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(family).toContainText("Uncheck Unknown");
    // Other Past Medical Hx fields are not affected.
    await expect(field(page, "past_medical_history").getByLabel("Past Medical Hx — visit-only free text")).toBeEnabled();
    await expect(field(page, "prior_test_results").locator("textarea")).toBeEnabled();

    await page.reload();
    await expect(unknown).toBeChecked();
    await expect(family.getByLabel("Family Medical Hx — visit-only free text")).toBeDisabled();

    await unknown.uncheck();
    await expect(statusOf(page, "family_history_unknown")).toHaveText("Saved");
    await expect(family.getByLabel("Family Medical Hx — visit-only free text")).toBeEnabled();

    const history = await entryHistory(visit.visitId, "family_history_unknown");
    expect(history.map((r) => r.checked)).toEqual([true, false]);
    // The user cleared Family Medical Hx themselves; nothing was rewritten silently.
    expect((await entryHistory(visit.visitId, "family_history")).map((r) => r.optionIds.length)).toEqual([1, 0]);
  });

  test("None / No known exclude Current Meds / Allergies on Subj", async ({ page }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));

    await page.getByRole("checkbox", { name: "None", exact: true }).check();
    await expect(statusOf(page, "current_meds_none")).toHaveText("Saved");
    await expect(field(page, "current_meds").getByLabel("Current Meds — visit-only free text")).toBeDisabled();
    await expect(field(page, "allergies").getByLabel("Allergies — visit-only free text")).toBeEnabled();

    await field(page, "allergies").getByLabel("Allergies — visit-only free text").fill("penicillin");
    await expect(statusOf(page, "allergies")).toHaveText("Saved");
    await expect(page.getByRole("checkbox", { name: "No known" })).toBeDisabled();
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

      await field(page, "family_history_unknown").getByRole("checkbox", { name: "Unknown" }).check();
      await expect(statusOf(page, "family_history_unknown")).toHaveText("Saved");

      const box = field(stale, "family_history").getByLabel("Family Medical Hx — visit-only free text");
      await expect(box).toBeEnabled();
      await box.pressSequentially("father");
      await expect(statusOf(stale, "family_history")).toHaveText("Not saved");
      await expect(field(stale, "family_history")).toContainText("cannot have values while");
      await expect(unsavedBanner(stale)).toContainText("not saved yet");
      await expect(box).toHaveValue("father");
      expect(await entryHistory(visit.visitId, "family_history")).toHaveLength(0);
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
    await field(page, "assessment_additional_comments").locator("textarea").pressSequentially("thigh 50 cm");
    await tabsNav(page).getByRole("link", { name: "Past Medical Hx" }).click();
    await expect(page).toHaveURL(tabUrl(visit, PMH_TAB));
    await expect(discardDialog(page)).toHaveCount(0);
    expect((await entryHistory(visit.visitId, "assessment_additional_comments")).map((r) => r.freeText)).toEqual([
      "thigh 50 cm",
    ]);

    // Failed: blocked until the user explicitly discards.
    await page.route(SAVE_API, (route) => route.abort("failed"));
    await field(page, "prior_test_results").locator("textarea").pressSequentially("lost on purpose");
    await expect(statusOf(page, "prior_test_results")).toHaveText("Not saved");
    await tabsNav(page).getByRole("link", { name: "Assessment Plan+" }).click();
    await expect(discardDialog(page)).toBeVisible();
    await discardDialog(page).getByRole("button", { name: "Discard unsaved text and leave" }).click();
    await expect(page).toHaveURL(tabUrl(visit, ASSESSMENT_TAB));
    await page.unroute(SAVE_API);
    expect(await entryHistory(visit.visitId, "prior_test_results")).toHaveLength(0);
  });

  test("permissions on the new tabs: nurse has no + Add New but can write and use Unknown; admin is read-only; reception has no tabs", async ({
    page,
    browser,
  }) => {
    const visit = await createVisitFixture();

    await loginAs(page, "nurse");
    await page.goto(tabUrl(visit, PMH_TAB));
    await expectDocumentedTabs(page);
    await openList(page, "past_medical_history", "Past Medical Hx");
    await expect(field(page, "past_medical_history").getByRole("checkbox").first().or(field(page, "past_medical_history").getByText("No options yet."))).toBeVisible();
    await expect(page.getByRole("button", { name: "+ Add New" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await field(page, "prior_test_results").locator("textarea").fill("nurse entry");
    await expect(statusOf(page, "prior_test_results")).toHaveText("Saved");
    await field(page, "family_history_unknown").getByRole("checkbox", { name: "Unknown" }).check();
    await expect(statusOf(page, "family_history_unknown")).toHaveText("Saved");
    await page.goto(tabUrl(visit, ASSESSMENT_TAB));
    await openList(page, "impression_1", "Impression 1");
    await expect(page.getByRole("button", { name: "+ Add New" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await field(page, "impression_1").getByRole("combobox").fill("nurse wording");
    await expect(statusOf(page, "impression_1")).toHaveText("Saved");

    const adminCtx = await browser.newContext();
    const receptionCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    const receptionPage = await receptionCtx.newPage();
    try {
      await loginAs(adminPage, "admin");
      await adminPage.goto(tabUrl(visit, PMH_TAB));
      await expect(adminPage.getByText("read-only access")).toBeVisible();
      await expect(field(adminPage, "prior_test_results").locator("textarea")).toBeDisabled();
      await expect(field(adminPage, "family_history_unknown").getByRole("checkbox", { name: "Unknown" })).toBeDisabled();
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
