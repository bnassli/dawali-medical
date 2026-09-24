import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import {
  clinicalAudits,
  closeVisit,
  createPatientFixture,
  createVisitFixture,
  discardDialog,
  entryHistory,
  field,
  loginAs,
  revokeSessions,
  seedEntry,
  setFieldActive,
  statusOf,
  uniq,
  unsavedBanner,
  user,
  visitUrl,
  withDb,
} from "./support";

const SAVE_API = "**/api/visits/*/clinical-entries/*";

/** Make every autosave request fail at the network level (offline server). */
async function breakNetwork(page: Page): Promise<void> {
  await page.route(SAVE_API, (route) => route.abort("failed"));
}

async function restoreNetwork(page: Page): Promise<void> {
  await page.unroute(SAVE_API);
}

test.describe("no silent loss on in-app navigation or Logout", () => {
  test("session expired: leaving via a link needs an explicit discard; Escape/Stay keeps the text", async ({
    page,
  }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "expiry");
    await page.goto(visitUrl(visit));
    await revokeSessions(user("expiry").userId);

    const box = field(page, "comments").locator("textarea");
    await box.pressSequentially("precious note");
    await expect(statusOf(page, "comments")).toHaveText("Session expired — not saved");

    const back = page.getByRole("link", { name: "Back to patient" });
    await back.click();
    const dialog = discardDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Comment");
    await expect(dialog).toContainText("Session expired");
    await expect(page).toHaveURL(visitUrl(visit));

    // Keyboard: focus starts on the safe choice, Tab cycles inside the dialog, Escape stays.
    await expect(dialog.getByRole("button", { name: "Stay on page" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Discard unsaved text and leave" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Stay on page" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "Discard unsaved text and leave" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(visitUrl(visit));
    await expect(box).toHaveValue("precious note");
    await expect(unsavedBanner(page)).toContainText("not saved yet");
    await expect(back).toBeFocused();

    // Explicit discard is the only way out.
    await back.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Discard unsaved text and leave" }).click();
    await expect(page).not.toHaveURL(visitUrl(visit));
    expect(await entryHistory(visit.visitId, "comments")).toHaveLength(0);
  });

  test("server unreachable: link navigation is blocked; after Retry succeeds, leaving needs no prompt", async ({
    page,
  }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));
    await breakNetwork(page);

    const box = field(page, "comments").locator("textarea");
    await box.pressSequentially("saved once the network is back");
    await expect(statusOf(page, "comments")).toHaveText("Not saved");

    await page.getByRole("link", { name: "Back to patient" }).click();
    await expect(discardDialog(page)).toBeVisible();
    await discardDialog(page).getByRole("button", { name: "Stay on page" }).click();
    await expect(discardDialog(page)).toBeHidden();
    await expect(page).toHaveURL(visitUrl(visit));
    await expect(box).toHaveValue("saved once the network is back");

    await restoreNetwork(page);
    await field(page, "comments").getByRole("button", { name: "Retry save" }).click();
    await expect(statusOf(page, "comments")).toHaveText("Saved");
    await expect(unsavedBanner(page)).toHaveText("");

    await page.getByRole("link", { name: "Back to patient" }).click();
    await expect(page).toHaveURL(`/patients/${visit.patientId}`);
    expect((await entryHistory(visit.visitId, "comments")).map((r) => r.freeText)).toEqual([
      "saved once the network is back",
    ]);
  });

  test("a pending (not yet failed) edit is flushed by the navigation itself: no prompt, nothing lost", async ({
    page,
  }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));

    await field(page, "chest_comments").locator("textarea").pressSequentially("typed then clicked away");
    await page.getByRole("link", { name: "Back to patient" }).click();
    await expect(page).toHaveURL(`/patients/${visit.patientId}`);
    await expect(discardDialog(page)).toHaveCount(0);
    expect((await entryHistory(visit.visitId, "chest_comments")).map((r) => r.freeText)).toEqual([
      "typed then clicked away",
    ]);
  });

  test("Logout with a failed save asks first; Stay keeps the session and text; once saved, Logout goes through", async ({
    page,
  }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));
    await breakNetwork(page);

    const box = field(page, "comments").locator("textarea");
    await box.pressSequentially("do not lose me on logout");
    await expect(statusOf(page, "comments")).toHaveText("Not saved");

    await page.getByRole("button", { name: "Logout" }).click();
    await expect(discardDialog(page)).toBeVisible();
    await discardDialog(page).getByRole("button", { name: "Stay on page" }).click();
    await expect(page).toHaveURL(visitUrl(visit));
    await expect(page.getByRole("button", { name: "Logout" })).toBeVisible();
    await expect(box).toHaveValue("do not lose me on logout");

    await restoreNetwork(page);
    await field(page, "comments").getByRole("button", { name: "Retry save" }).click();
    await expect(statusOf(page, "comments")).toHaveText("Saved");

    await page.getByRole("button", { name: "Logout" }).click();
    await page.waitForURL("**/login");
    expect((await entryHistory(visit.visitId, "comments")).map((r) => r.freeText)).toEqual([
      "do not lose me on logout",
    ]);
  });

  test("Logout with a failed save: explicit discard logs out and drops the text", async ({ page }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));
    await breakNetwork(page);

    await field(page, "comments").locator("textarea").pressSequentially("thrown away on purpose");
    await expect(statusOf(page, "comments")).toHaveText("Not saved");
    await page.getByRole("button", { name: "Logout" }).click();
    await expect(discardDialog(page)).toBeVisible();
    await discardDialog(page).getByRole("button", { name: "Discard unsaved text and leave" }).click();
    await page.waitForURL("**/login");
    await restoreNetwork(page);

    // Really logged out.
    await page.goto("/patients");
    await page.waitForURL("**/login");
    expect(await entryHistory(visit.visitId, "comments")).toHaveLength(0);
  });

  test("Logout with a still-pending edit flushes it first, without a prompt", async ({ page }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));

    await field(page, "comments").locator("textarea").pressSequentially("saved by logout");
    await page.getByRole("button", { name: "Logout" }).click();
    await page.waitForURL("**/login");
    await expect(discardDialog(page)).toHaveCount(0);
    expect((await entryHistory(visit.visitId, "comments")).map((r) => r.freeText)).toEqual([
      "saved by logout",
    ]);
  });

  test("Logout when the session already expired still asks before dropping text", async ({ page }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "expiry");
    await page.goto(visitUrl(visit));
    await revokeSessions(user("expiry").userId);

    await field(page, "comments").locator("textarea").pressSequentially("typed after expiry");
    await expect(statusOf(page, "comments")).toHaveText("Session expired — not saved");
    await page.getByRole("button", { name: "Logout" }).click();
    await expect(discardDialog(page)).toBeVisible();
    await discardDialog(page).getByRole("button", { name: "Stay on page" }).click();
    await expect(field(page, "comments").locator("textarea")).toHaveValue("typed after expiry");
  });

  test("a save conflict and a locked visit also block navigation until discarded", async ({ page, browser }) => {
    // Conflict.
    const conflictVisit = await createVisitFixture();
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    try {
      await loginAs(page, "doctor");
      await loginAs(pageA, "nurse");
      await page.goto(visitUrl(conflictVisit));
      await pageA.goto(visitUrl(conflictVisit));
      await field(pageA, "comments").locator("textarea").fill("nurse was first");
      await expect(statusOf(pageA, "comments")).toHaveText("Saved");
      await field(page, "comments").locator("textarea").fill("doctor was second");
      await expect(statusOf(page, "comments")).toHaveText("Conflict");

      await page.getByRole("link", { name: "Back to patient" }).click();
      await expect(discardDialog(page)).toBeVisible();
      await expect(discardDialog(page)).toContainText("Conflict");
      await discardDialog(page).getByRole("button", { name: "Discard unsaved text and leave" }).click();
      await expect(page).toHaveURL(`/patients/${conflictVisit.patientId}`);
      expect((await entryHistory(conflictVisit.visitId, "comments")).map((r) => r.freeText)).toEqual([
        "nurse was first",
      ]);
    } finally {
      await ctxA.close();
    }

    // Locked (visit closed after the page loaded).
    const lockedVisit = await createVisitFixture();
    await page.goto(visitUrl(lockedVisit));
    await closeVisit(lockedVisit.visitId);
    await field(page, "comments").locator("textarea").fill("too late");
    await expect(statusOf(page, "comments")).toHaveText("Locked — not saved");
    await page.getByRole("link", { name: "Back to patient" }).click();
    await expect(discardDialog(page)).toBeVisible();
    await expect(discardDialog(page)).toContainText("Locked");
    await discardDialog(page).getByRole("button", { name: "Stay on page" }).click();
    await expect(page).toHaveURL(visitUrl(lockedVisit));
    expect(await entryHistory(lockedVisit.visitId, "comments")).toHaveLength(0);
  });

  test("links that open elsewhere or download are not intercepted (no false prompts)", async ({ page, context }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "expiry");
    await page.goto(visitUrl(visit));
    await revokeSessions(user("expiry").userId);
    await field(page, "comments").locator("textarea").pressSequentially("unsaved");
    await expect(statusOf(page, "comments")).toHaveText("Session expired — not saved");

    // The "Sign in again" link opens a new tab: allowed without a prompt.
    const [popup] = await Promise.all([
      context.waitForEvent("page"),
      page.getByRole("link", { name: /Sign in again/ }).first().click(),
    ]);
    await popup.close();
    await expect(discardDialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(visitUrl(visit));
  });
});

test.describe("autosave is bound to the user the page was rendered for", () => {
  test("a different user signing in on the same browser can never receive the previous user's text", async ({
    page,
    context,
  }) => {
    const visit = await createVisitFixture();
    const doctor = user("doctor");
    const nurse = user("nurse");
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));

    // Someone else signs in on this browser (cookie now belongs to the nurse).
    const other = await context.newPage();
    await context.clearCookies();
    await loginAs(other, "nurse");
    await other.close();

    const box = field(page, "comments").locator("textarea");
    await box.pressSequentially("doctor's private note");
    await expect(statusOf(page, "comments")).toHaveText("Signed in as another user — not saved");
    await expect(field(page, "comments")).toContainText("different user");
    await expect(box).toHaveValue("doctor's private note");
    await expect(unsavedBanner(page)).toContainText("not saved yet");

    // Nothing was saved under either user, and the attempt was audited.
    expect(await entryHistory(visit.visitId, "comments")).toHaveLength(0);
    const denied = await withDb((db) =>
      db.execute<{ metadata: { reason?: string; expectedUserId?: string } }>(
        sql`SELECT metadata FROM audit_logs WHERE action = 'access.denied' AND visit_id = ${visit.visitId}`,
      ),
    );
    expect(denied.rows.some((r) => r.metadata.reason === "actor_mismatch" && r.metadata.expectedUserId === doctor.userId)).toBe(true);
    expect(nurse.userId).not.toBe(doctor.userId);

    // Retry keeps failing while the wrong user is signed in...
    await field(page, "comments").getByRole("button", { name: "Retry save" }).click();
    await expect(statusOf(page, "comments")).toHaveText("Signed in as another user — not saved");
    expect(await entryHistory(visit.visitId, "comments")).toHaveLength(0);

    // ...navigating away needs an explicit discard...
    await page.getByRole("link", { name: "Back to patient" }).click();
    await expect(discardDialog(page)).toBeVisible();
    await discardDialog(page).getByRole("button", { name: "Stay on page" }).click();

    // ...and once the original user is signed in again, the same text saves as THEM.
    await context.clearCookies();
    const back = await context.newPage();
    await loginAs(back, "doctor");
    await back.close();
    await field(page, "comments").getByRole("button", { name: "Retry save" }).click();
    await expect(statusOf(page, "comments")).toHaveText("Saved");
    const history = await entryHistory(visit.visitId, "comments");
    expect(history.map((r) => r.freeText)).toEqual(["doctor's private note"]);
    expect(history[0]?.createdBy).toBe(doctor.userId);
  });

  test("'+ Add New' from a stale page is also refused for a different signed-in user", async ({ page, context }) => {
    const visit = await createVisitFixture();
    await loginAs(page, "doctor");
    await page.goto(visitUrl(visit));

    const other = await context.newPage();
    await context.clearCookies();
    await loginAs(other, "nurse");
    await other.close();

    const label = `Should not exist ${uniq()}`;
    const allergies = field(page, "allergies");
    await allergies.getByLabel("New Allergies option").fill(label);
    await allergies.getByRole("button", { name: "+ Add New" }).click();
    await expect(allergies).toContainText("different user");
    await expect(allergies.getByRole("checkbox", { name: label })).toHaveCount(0);
    const count = await withDb(async (db) => {
      const r = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM clinical_options WHERE label = ${label}`);
      return Number(r.rows[0]?.n ?? 0);
    });
    expect(count).toBe(0);
  });
});

test.describe("switching visits never reuses savers or field state", () => {
  test("V1 -> V2 -> V1 (and refresh): every save goes to the visit on screen", async ({ page }) => {
    const v1 = await createVisitFixture();
    const v2 = await createVisitFixture({ patientId: v1.patientId });
    await loginAs(page, "doctor");

    const posted: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && /\/api\/visits\/[^/]+\/clinical-entries\//.test(req.url())) {
        posted.push(req.url().split("/api/visits/")[1]?.split("/")[0] ?? "");
      }
    });
    const visitOnScreen = () => page.locator("[data-visit-id]").first().getAttribute("data-visit-id");
    const openVisitFromPatientPage = async (visitId: string) => {
      await page.locator(`a[href$="/visits/${visitId}"]`).click();
      await page.waitForURL(`**/visits/${visitId}`);
      await expect(page.locator("[data-visit-id]").first()).toHaveAttribute("data-visit-id", visitId);
    };

    // V1
    await page.goto(visitUrl(v1));
    expect(await visitOnScreen()).toBe(v1.visitId);
    await field(page, "comments").locator("textarea").fill("text for V1");
    await expect(statusOf(page, "comments")).toHaveText("Saved");

    // -> V2 through the app (client-side navigation, no full reload)
    await page.getByRole("link", { name: "Back to patient" }).click();
    await page.waitForURL(`**/patients/${v1.patientId}`);
    await openVisitFromPatientPage(v2.visitId);
    // V2 shows V2's (empty) data, never V1's.
    await expect(field(page, "comments").locator("textarea")).toHaveValue("");
    await expect(statusOf(page, "comments")).toHaveText("");
    await field(page, "comments").locator("textarea").fill("text for V2");
    await expect(statusOf(page, "comments")).toHaveText("Saved");

    // -> back to V1 via the browser history (Back, Back)
    await page.goBack();
    await page.waitForURL(`**/patients/${v1.patientId}`);
    await page.goBack();
    await page.waitForURL(`**/visits/${v1.visitId}`);
    await expect(page.locator("[data-visit-id]").first()).toHaveAttribute("data-visit-id", v1.visitId);
    await expect(field(page, "comments").locator("textarea")).toHaveValue("text for V1");
    await field(page, "comments").locator("textarea").fill("text for V1, edited");
    await expect(statusOf(page, "comments")).toHaveText("Saved");

    // Refresh keeps everything on the right visit.
    await page.reload();
    await expect(page.locator("[data-visit-id]").first()).toHaveAttribute("data-visit-id", v1.visitId);
    await expect(field(page, "comments").locator("textarea")).toHaveValue("text for V1, edited");
    await field(page, "comments").locator("textarea").fill("text for V1, after refresh");
    await expect(statusOf(page, "comments")).toHaveText("Saved");

    expect(posted).toEqual([v1.visitId, v2.visitId, v1.visitId, v1.visitId]);
    expect((await entryHistory(v1.visitId, "comments")).map((r) => [r.version, r.freeText])).toEqual([
      [1, "text for V1"],
      [2, "text for V1, edited"],
      [3, "text for V1, after refresh"],
    ]);
    expect((await entryHistory(v2.visitId, "comments")).map((r) => [r.version, r.freeText])).toEqual([
      [1, "text for V2"],
    ]);
  });

  test("typing in V1 and immediately opening V2: V1's text is saved to V1, V2 starts clean", async ({ page }) => {
    const v1 = await createVisitFixture();
    const v2 = await createVisitFixture({ patientId: v1.patientId });
    await loginAs(page, "doctor");
    await page.goto(visitUrl(v1));

    await field(page, "comments").locator("textarea").pressSequentially("V1 quick text");
    await page.getByRole("link", { name: "Back to patient" }).click();
    await page.waitForURL(`**/patients/${v1.patientId}`);
    await page.locator(`a[href$="/visits/${v2.visitId}"]`).click();
    await page.waitForURL(`**/visits/${v2.visitId}`);
    await expect(field(page, "comments").locator("textarea")).toHaveValue("");
    await field(page, "comments").locator("textarea").pressSequentially("V2 quick text");
    await expect(statusOf(page, "comments")).toHaveText("Saved");

    expect((await entryHistory(v1.visitId, "comments")).map((r) => r.freeText)).toEqual(["V1 quick text"]);
    expect((await entryHistory(v2.visitId, "comments")).map((r) => r.freeText)).toEqual(["V2 quick text"]);
  });
});

test.describe("intake Reason for Visit length", () => {
  test("the form caps input at 5000 characters and the server rejects more (no visit created)", async ({ page }) => {
    const patientId = await createPatientFixture();
    await loginAs(page, "doctor");
    await page.goto(`/patients/${patientId}`);

    const input = page.getByLabel("Reason for new visit");
    await expect(input).toHaveAttribute("maxlength", "5000");

    // Bypass the browser cap to prove the server enforces it too.
    await input.evaluate((el) => el.removeAttribute("maxlength"));
    await input.fill("x".repeat(5001));
    await page.getByRole("button", { name: "New visit" }).click();
    await expect(page.getByText("at most 5000 characters")).toBeVisible();
    const visits = await withDb(async (db) => {
      const r = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM visits WHERE patient_id = ${patientId}`);
      return Number(r.rows[0]?.n ?? 0);
    });
    expect(visits).toBe(0);

    // Exactly 5000 is accepted.
    await page.getByLabel("Reason for new visit").fill("y".repeat(5000));
    await page.getByRole("button", { name: "New visit" }).click();
    await page.waitForURL(/\/visits\//);
    await expect(page.getByLabel("Reason for Visit — visit-only free text")).toHaveValue("y".repeat(5000));
  });
});

test.describe("retired fields keep history visible", () => {
  test("a retired field with history on this visit stays visible and read-only; hidden where there is nothing to lose", async ({
    page,
  }) => {
    const withHistory = await createVisitFixture();
    const without = await createVisitFixture();
    await seedEntry(withHistory.visitId, "tobacco", "quit in 2019");
    await setFieldActive("tobacco", false);
    try {
      await loginAs(page, "doctor");
      await page.goto(visitUrl(withHistory));
      const tobacco = field(page, "tobacco");
      await expect(tobacco).toBeVisible();
      await expect(tobacco).toHaveAttribute("data-field-active", "false");
      await expect(tobacco).toContainText("retired field, read-only");
      await expect(tobacco.getByLabel("Tobacco — visit-only free text")).toHaveValue("quit in 2019");
      await expect(tobacco.getByLabel("Tobacco — visit-only free text")).toBeDisabled();
      await expect(tobacco.getByRole("combobox")).toBeDisabled();
      await expect(tobacco.getByRole("button", { name: "+ Add New" })).toHaveCount(0);
      // Field order is unchanged around it.
      const labels = await page.locator(".clinical-field .field-head label").allTextContents();
      expect(labels.indexOf("Alcohol")).toBeGreaterThanOrEqual(0);
      expect(labels[labels.indexOf("Exercise") + 1]?.startsWith("Tobacco")).toBe(true);

      await page.goto(visitUrl(without));
      await expect(field(page, "tobacco")).toHaveCount(0);
    } finally {
      await setFieldActive("tobacco", true);
    }
  });
});

test("audit rows exist for the conflict-free happy path of a guarded navigation (sanity)", async ({ page }) => {
  const visit = await createVisitFixture();
  await loginAs(page, "doctor");
  await page.goto(visitUrl(visit));
  await field(page, "comments").locator("textarea").fill("audited");
  await expect(statusOf(page, "comments")).toHaveText("Saved");
  const audits = await clinicalAudits(visit.visitId);
  expect(audits.map((a) => a.action)).toEqual(["clinical_entry.create"]);
});
