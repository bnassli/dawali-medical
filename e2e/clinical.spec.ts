import { expect, test, type Dialog } from "@playwright/test";
import {
  clinicalAuditCount,
  clinicalAudits,
  createPatientFixture,
  createVisitFixture,
  entryHistory,
  field,
  legacyVisitReason,
  loginAs,
  optionLabels,
  revokeSessions,
  statusOf,
  uniq,
  unsavedBanner,
  user,
  visitUrl,
} from "./support";

// Order from docs/CLINICAL_TABS.md, "Subj Complaints Habits" (labels reconciled in R1b, ADR-029).
const SUBJ_COMPLAINTS_HABITS_ORDER = [
  "Reason for Visit",
  "Problem List",
  "Chief Complaints",
  "Associated condition",
  "How long?",
  "Symptoms getting worse over time?",
  "Daily Activity Impact",
  "Additional Comments",
  "Comments",
  "Aggravating Factors",
  "Relieving Factors",
  "Previous Conservative Therapy",
  "Previous Conservative Therapy Duration",
  "Family history of VV?",
  "Alcohol",
  "Exercise",
  "Tobacco",
  "Pain Meds for CC",
  "Current Meds",
  "Allergies",
];

test.describe("Subj Complaints Habits (browser)", () => {
  test("renders the tab with fields in the exact CLINICAL_TABS.md order", async ({ page }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));

    await expect(
      page.getByRole("navigation", { name: "Clinical tabs" }).getByText("Subj Complaints Habits"),
    ).toBeVisible();
    await expect(page.locator(".clinical-field .field-head label")).toHaveText(
      SUBJ_COMPLAINTS_HABITS_ORDER,
    );
  });

  test("selections and free text persist across a reload (select, multiselect, textarea)", async ({
    page,
  }) => {
    const visit = await createVisitFixture();
    const s = uniq();
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));

    const duration = field(page, "duration");
    await duration.getByLabel("New How long? option").fill(`Under a week ${s}`);
    await duration.getByRole("button", { name: "+ Add New" }).click();
    await expect(statusOf(page, "duration")).toHaveText("Saved");

    const aggravating = field(page, "aggravating_factors");
    for (const label of [`Standing ${s}`, `Heat ${s}`]) {
      await aggravating.getByLabel("New Aggravating Factors option").fill(label);
      await aggravating.getByRole("button", { name: "+ Add New" }).click();
      await expect(aggravating.getByRole("checkbox", { name: label })).toBeChecked();
    }
    await expect(statusOf(page, "aggravating_factors")).toHaveText("Saved");

    await field(page, "comments").locator("textarea").fill(`note ${s}`);
    await expect(statusOf(page, "comments")).toHaveText("Saved");
    await duration.getByLabel("How long? — visit-only free text").fill(`about 5 days ${s}`);
    await expect(statusOf(page, "duration")).toHaveText("Saved");

    await page.reload();

    await expect(duration.getByRole("combobox")).toHaveValue(/.+/);
    await expect(duration.getByRole("combobox").locator("option:checked")).toHaveText(
      `Under a week ${s}`,
    );
    await expect(duration.getByLabel("How long? — visit-only free text")).toHaveValue(
      `about 5 days ${s}`,
    );
    await expect(aggravating.getByRole("checkbox", { name: `Standing ${s}` })).toBeChecked();
    await expect(aggravating.getByRole("checkbox", { name: `Heat ${s}` })).toBeChecked();
    await expect(field(page, "comments").locator("textarea")).toHaveValue(`note ${s}`);

    expect((await entryHistory(visit.visitId, "aggravating_factors")).at(-1)?.optionIds).toHaveLength(2);
  });

  test("permanent options are shared across visits; visit-only free text is not", async ({
    page,
  }) => {
    const visitA = await createVisitFixture();
    const visitB = await createVisitFixture({ patientId: visitA.patientId });
    const s = uniq();
    const permanent = `Latex ${s}`;
    const visitOnly = `only-this-visit ${s}`;

    await loginAs(page, "doctor");
    await page.goto(visitUrl(visitA));
    const allergiesA = field(page, "allergies");
    await allergiesA.getByLabel("New Allergies option").fill(permanent);
    await allergiesA.getByRole("button", { name: "+ Add New" }).click();
    await allergiesA.getByLabel("Allergies — visit-only free text").fill(visitOnly);
    await expect(statusOf(page, "allergies")).toHaveText("Saved");

    await page.goto(visitUrl(visitB));
    const allergiesB = field(page, "allergies");
    await expect(allergiesB.getByRole("checkbox", { name: permanent })).toBeVisible();
    await expect(allergiesB.getByRole("checkbox", { name: permanent })).not.toBeChecked();
    await expect(allergiesB.getByLabel("Allergies — visit-only free text")).toHaveValue("");
    await expect(page.getByText(visitOnly)).toHaveCount(0);

    const labels = await optionLabels();
    expect(labels).toContain(permanent);
    expect(labels).not.toContain(visitOnly);
    expect((await entryHistory(visitA.visitId, "allergies")).at(-1)?.freeText).toBe(visitOnly);
    expect(await entryHistory(visitB.visitId, "allergies")).toHaveLength(0);
  });

  test("can be operated entirely from the keyboard", async ({ page }) => {
    const visit = await createVisitFixture();
    const s = uniq();
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));

    // Natural tab order inside a field: control -> free text -> new-option input.
    await page.getByLabel("Reason for Visit", { exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Reason for Visit — visit-only free text")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("New Reason for Visit option")).toBeFocused();

    // Add two options with Enter in the new-option input.
    const progression = field(page, "daily_activity_impact");
    const newOption = page.getByLabel("New Daily Activity Impact option");
    for (const label of [`Stable ${s}`, `Improving ${s}`]) {
      await newOption.focus();
      await page.keyboard.type(label);
      await page.keyboard.press("Enter");
      await expect(progression.getByRole("combobox").locator("option:checked")).toHaveText(label);
    }
    await expect(statusOf(page, "daily_activity_impact")).toHaveText("Saved");

    // Change the select with the arrow keys only.
    await progression.getByRole("combobox").focus();
    await page.keyboard.press("ArrowUp");
    await expect(progression.getByRole("combobox").locator("option:checked")).toHaveText(`Stable ${s}`);
    await expect(statusOf(page, "daily_activity_impact")).toHaveText("Saved");

    // Toggle a checkbox with Space.
    const family = field(page, "family_history");
    await family.getByLabel("New Family history of VV? option").focus();
    await page.keyboard.type(`Father ${s}`);
    await page.keyboard.press("Enter");
    const checkbox = family.getByRole("checkbox", { name: `Father ${s}` });
    await expect(checkbox).toBeChecked();
    await expect(statusOf(page, "family_history")).toHaveText("Saved");
    await checkbox.focus();
    await page.keyboard.press("Space");
    await expect(checkbox).not.toBeChecked();
    await expect(statusOf(page, "family_history")).toHaveText("Saved");

    await page.reload();
    await expect(
      field(page, "daily_activity_impact").getByRole("combobox").locator("option:checked"),
    ).toHaveText(`Stable ${s}`);
    await expect(
      field(page, "family_history").getByRole("checkbox", { name: `Father ${s}` }),
    ).not.toBeChecked();
  });

  test("a concurrent edit is a visible Conflict (Use theirs / Keep mine), never last-write-wins", async ({
    page,
    browser,
  }) => {
    const visit = await createVisitFixture();
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    try {
      await loginAs(page, "doctor");
      await loginAs(pageB, "nurse");
      await page.goto(visitUrl(visit));
      await pageB.goto(visitUrl(visit));
      const boxA = field(page, "comments").locator("textarea");
      const boxB = field(pageB, "comments").locator("textarea");

      // Both loaded version 0. A saves first.
      await boxA.fill("from A");
      await expect(statusOf(page, "comments")).toHaveText("Saved");
      const auditAfterA = await clinicalAuditCount(visit.visitId);

      // B's save is stale.
      await boxB.fill("from B");
      await expect(statusOf(pageB, "comments")).toHaveText("Conflict");
      const conflictB = field(pageB, "comments").getByRole("alert");
      await expect(conflictB).toContainText("Theirs: from A");
      await expect(conflictB).toContainText("Mine: from B");
      await expect(unsavedBanner(pageB)).toContainText("not saved yet");

      // Nothing was written for the losing save.
      expect((await entryHistory(visit.visitId, "comments")).map((r) => r.freeText)).toEqual(["from A"]);
      expect(await clinicalAuditCount(visit.visitId)).toBe(auditAfterA);
      // While the conflict is open the field is not editable and nothing is auto-sent.
      await expect(boxB).toBeDisabled();

      // Use theirs, chosen with the keyboard.
      const useTheirs = conflictB.getByRole("button", { name: "Use theirs" });
      await useTheirs.focus();
      await pageB.keyboard.press("Enter");
      await expect(boxB).toHaveValue("from A");
      await expect(statusOf(pageB, "comments")).toHaveText("Saved");
      await expect(unsavedBanner(pageB)).toHaveText("");
      expect(await entryHistory(visit.visitId, "comments")).toHaveLength(1);

      // B now edits on top of A's version: a normal save (v2), no conflict.
      await boxB.fill("from B, second thoughts");
      await expect(statusOf(pageB, "comments")).toHaveText("Saved");
      const history = await entryHistory(visit.visitId, "comments");
      expect(history.map((r) => [r.version, r.freeText])).toEqual([
        [1, "from A"],
        [2, "from B, second thoughts"],
      ]);

      // A is now stale (still version 1). Keep mine deliberately writes v3 on top.
      await boxA.fill("A again");
      await expect(statusOf(page, "comments")).toHaveText("Conflict");
      await expect(field(page, "comments").getByRole("alert")).toContainText(
        "Theirs: from B, second thoughts",
      );
      await field(page, "comments").getByRole("button", { name: "Keep mine" }).click();
      await expect(statusOf(page, "comments")).toHaveText("Saved");
      await expect(boxA).toHaveValue("A again");

      const finalHistory = await entryHistory(visit.visitId, "comments");
      expect(finalHistory.map((r) => [r.version, r.freeText])).toEqual([
        [1, "from A"],
        [2, "from B, second thoughts"],
        [3, "A again"],
      ]);
      const updates = (await clinicalAudits(visit.visitId)).filter(
        (a) => a.action === "clinical_entry.update",
      );
      expect(updates).toHaveLength(2);
      expect(updates[1]?.before).toMatchObject({ version: 2, value: { freeText: "from B, second thoughts" } });
    } finally {
      await contextB.close();
    }
  });

  test("session expiry keeps the unsaved text, warns, and saves after signing in again", async ({
    page,
    context,
  }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "expiry");
    await page.goto(visitUrl(visit));

    await revokeSessions(user("expiry").userId);

    const box = field(page, "comments").locator("textarea");
    await box.pressSequentially("important unsaved note");
    await expect(unsavedBanner(page)).toContainText("not saved yet");
    await expect(statusOf(page, "comments")).toHaveText("Session expired — not saved");

    // The text is still there and still flagged; nothing persisted to browser storage.
    await expect(box).toHaveValue("important unsaved note");
    await expect(unsavedBanner(page)).toContainText("not saved yet");
    await expect(page.getByRole("link", { name: /Sign in again/ }).first()).toBeVisible();
    expect(
      await page.evaluate(() => window.localStorage.length + window.sessionStorage.length),
    ).toBe(0);
    expect(await entryHistory(visit.visitId, "comments")).toHaveLength(0);

    // Sign in again in another tab of the same browser, then retry here.
    const other = await context.newPage();
    await loginAs(other, "expiry");
    await other.close();

    await field(page, "comments").getByRole("button", { name: "Retry save" }).click();
    await expect(statusOf(page, "comments")).toHaveText("Saved");
    await expect(unsavedBanner(page)).toHaveText("");
    expect((await entryHistory(visit.visitId, "comments")).map((r) => r.freeText)).toEqual([
      "important unsaved note",
    ]);
  });

  test("reloading right after typing does not drop the last edit (keepalive flush + warning)", async ({
    page,
  }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));

    const dialogs: string[] = [];
    const onDialog = (d: Dialog) => {
      dialogs.push(d.type());
      void d.accept();
    };
    page.on("dialog", onDialog);

    const box = field(page, "comments").locator("textarea");
    await box.pressSequentially("typed just before reload");
    await expect(unsavedBanner(page)).toContainText("not saved yet");
    await page.reload();

    expect(dialogs).toContain("beforeunload");
    await expect
      .poll(async () => (await entryHistory(visit.visitId, "comments")).at(-1)?.freeText, {
        timeout: 15_000,
      })
      .toBe("typed just before reload");
    await expect(field(page, "comments").locator("textarea")).toHaveValue("typed just before reload");
    await expect(unsavedBanner(page)).toHaveText("");
    expect(await entryHistory(visit.visitId, "comments")).toHaveLength(1);
    page.off("dialog", onDialog);
  });

  test("navigating away within the app right after typing does not drop the edit", async ({
    page,
  }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));

    await field(page, "chest_comments").locator("textarea").pressSequentially("chest tight on stairs");
    await page.getByRole("link", { name: "Back to patient" }).click();
    await page.waitForURL(`**/patients/${visit.patientId}`);

    await expect
      .poll(async () => (await entryHistory(visit.visitId, "chest_comments")).at(-1)?.freeText, {
        timeout: 15_000,
      })
      .toBe("chest tight on stairs");
  });

  test("Reason for Visit has a single source: intake text lands in the clinical field, edits flow back to readers", async ({
    page,
  }) => {
    const patientId = await createPatientFixture();
    await loginAs(page, "doctor");
    await page.goto(`/patients/${patientId}`);

    await page.getByLabel("Reason for new visit").fill("Swollen ankle");
    await page.getByRole("button", { name: "New visit" }).click();
    await page.waitForURL(/\/visits\//);
    const visitId = page.url().split("/visits/")[1] ?? "";

    await expect(page.getByLabel("Reason for Visit — visit-only free text")).toHaveValue(
      "Swollen ankle",
    );
    await expect(page.getByText("Reason: Swollen ankle")).toBeVisible();
    expect(await legacyVisitReason(visitId)).toBeNull();
    expect((await entryHistory(visitId, "reason_for_visit")).map((r) => r.freeText)).toEqual([
      "Swollen ankle",
    ]);

    await page.getByLabel("Reason for Visit — visit-only free text").fill("Swollen ankle, left side");
    await expect(statusOf(page, "reason_for_visit")).toHaveText("Saved");

    await page.goto(`/patients/${patientId}`);
    await expect(page.getByRole("cell", { name: "Swollen ankle, left side" })).toBeVisible();
    expect(await legacyVisitReason(visitId)).toBeNull();
  });

  test("role differences: nurse cannot add permanent options, admin is read-only, reception has no clinical access", async ({
    page,
    browser,
  }) => {
    const visit = await createVisitFixture({ reason: "role check" });

    await loginAs(page, "nurse");
    await page.goto(visitUrl(visit));
    await expect(field(page, "comments").locator("textarea")).toBeEnabled();
    await expect(page.getByRole("button", { name: "+ Add New" })).toHaveCount(0);
    await page.goto(`/patients/${visit.patientId}`);
    await expect(page.getByLabel("Reason for new visit")).toBeVisible();

    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    const receptionCtx = await browser.newContext();
    const receptionPage = await receptionCtx.newPage();
    try {
      await loginAs(adminPage, "admin");
      await adminPage.goto(visitUrl(visit));
      await expect(adminPage.getByText("read-only access")).toBeVisible();
      await expect(field(adminPage, "comments").locator("textarea")).toBeDisabled();
      await expect(adminPage.getByRole("button", { name: "+ Add New" }).first()).toBeVisible();

      await loginAs(receptionPage, "reception");
      await receptionPage.goto(visitUrl(visit));
      await expect(receptionPage.getByText("You do not have access to clinical entries.")).toBeVisible();
      await receptionPage.goto(`/patients/${visit.patientId}`);
      await expect(receptionPage.getByRole("columnheader", { name: "Reason" })).toHaveCount(0);
      // Reception cannot enter a Reason for Visit either, but can still create a visit.
      await expect(receptionPage.getByLabel("Reason for new visit")).toHaveCount(0);
      await expect(receptionPage.getByRole("button", { name: "New visit" })).toBeVisible();
    } finally {
      await adminCtx.close();
      await receptionCtx.close();
    }
  });
});
