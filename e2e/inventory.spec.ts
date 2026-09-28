import { expect, test, type Page } from "@playwright/test";
import { createVisitFixture, loginAs, uniq, visitUrl } from "./support";

/** The inventory screens are Arabic by default (I3); these flows are written in English. */
async function english(page: Page) {
  await page.context().addCookies([{ name: "inv_lang", value: "en", url: page.url().startsWith("http") ? page.url() : "http://localhost:3100" }]);
}

/** I1 (ADR-035): scan -> review -> receive; nurse records usage on patient + doctor. */

test("storekeeper receives a scanned invoice (reviewed), nurse charges usage to patient and doctor", async ({ page, browser }) => {
  const s = uniq();
  const product = `Polidocanol ${s}`;
  await loginAs(page, "store");
  await english(page);
  await page.goto("/inventory/receive");
  await expect(page.getByLabel("Store")).toHaveValue(/.+/);
  await expect(page.getByLabel("Store").locator("option").first()).toContainText("Operations Store");

  // Scan: stored; without an AI key the form is filled by hand (the draft is always reviewed).
  await page.getByLabel(/Scanned invoice/).setInputFiles({ name: "invoice.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a00", "hex") });
  await page.getByRole("button", { name: "Scan and read with AI" }).click();
  await expect(page.getByText(/enter the invoice by hand|check every value/)).toBeVisible();
  await page.getByLabel("Supplier").fill(`Pharma ${s}`);
  await page.getByLabel("Invoice number").fill(`INV-${s}`);
  await page.getByLabel("Invoice date").fill("2026-09-20");
  await page.getByLabel("Product 1").fill(product);
  await page.getByLabel("Unit 1").fill("vial");
  await page.getByLabel("Lot 1").fill("P1");
  await page.getByLabel("Expiry 1").fill("2027-06-30");
  await page.getByLabel("Quantity 1").fill("10");
  await page.getByRole("button", { name: "Confirm and add to stock" }).click();
  await expect(page.getByText(`Invoice INV-${s} received into stock.`)).toBeVisible();
  await page.goto("/inventory/stock");
  const stock = page.getByRole("region", { name: "Stock" });
  await expect(stock.getByRole("row", { name: new RegExp(product) })).toContainText("10 vial");

  const visit = await createVisitFixture();
  const nurseCtx = await browser.newContext();
  try {
    const nurse = await nurseCtx.newPage();
    await loginAs(nurse, "nurse");
    await nurse.goto(visitUrl(visit));
    const panel = nurse.getByRole("region", { name: "Materials used" });
    await panel.getByLabel("Item and batch").selectOption({ label: `Operations Store (مستودع العمليات): ${product} — lot P1, exp 30/06/2027 (10 vial left)` });
    await panel.getByLabel("Quantity used").fill("2");
    await panel.getByLabel("Doctor").selectOption({ label: "E2E doctor" });
    await panel.getByRole("button", { name: "Record" }).click();
    await expect(panel.getByText(new RegExp(`2 vial ${product} \\(lot P1\\) — Dr\\. E2E doctor`))).toBeVisible();
  } finally {
    await nurseCtx.close();
  }

  await page.reload();
  await expect(page.getByRole("region", { name: "Stock" }).getByRole("row", { name: new RegExp(product) })).toContainText("8 vial");
  await page.goto("/inventory");
  await expect(page.getByRole("region", { name: "Materials used by doctor" })).toContainText(`${product} (vial): 2`);
  await expect(page.getByRole("region", { name: "Latest movements" })).toContainText(product);
});

test("materials-used report: storekeeper filters and exports to Excel; nurse has no access", async ({ page, browser }) => {
  await loginAs(page, "store");
  await english(page);
  await page.goto("/inventory");
  await page.getByRole("link", { name: /Full report by period/ }).click();
  await expect(page.getByRole("heading", { name: "Materials used" })).toBeVisible();
  await expect(page.getByTestId("consumption-total")).toContainText("Total cost:");
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export to Excel" }).click();
  expect((await download).suggestedFilename()).toMatch(/^materials-used_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.xlsx$/);

  const nurseCtx = await browser.newContext();
  try {
    const nurse = await nurseCtx.newPage();
    await loginAs(nurse, "nurse");
    const res = await nurse.goto("/inventory/consumption");
    expect(res?.status()).toBe(404);
    expect((await nurse.request.get("/api/inventory/consumption?from=2026-01-01&to=2026-01-31")).status()).toBe(403);
  } finally {
    await nurseCtx.close();
  }
});

test("I3: Arabic by default with a language switch; catalogue, opening count and overview", async ({ page, browser }) => {
  const s = uniq();
  const name = `Gauze ${s}`;
  await loginAs(page, "store");
  await page.goto("/inventory");
  // Arabic, right to left, with the section's own navigation.
  await expect(page.locator(".inv-shell")).toHaveAttribute("dir", "rtl");
  const nav = page.getByRole("navigation", { name: "المستودع" });
  await expect(nav.getByRole("link", { name: "الرئيسية" })).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.locator(".inv-shell")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("navigation", { name: "Inventory" }).getByRole("link", { name: "Overview" })).toBeVisible();

  // Catalogue: new product with a minimum level.
  await page.getByRole("navigation", { name: "Inventory" }).getByRole("link", { name: "Products" }).click();
  await page.getByRole("button", { name: "+ New product" }).click();
  const row = page.getByRole("row", { name: "New product" });
  await row.getByLabel("Product").fill(name);
  await row.getByLabel("Unit").fill("piece");
  await row.getByLabel("Minimum level").fill("10");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");
  await expect(page.getByRole("row", { name: new RegExp(name) })).toContainText("10");

  // Opening count: the product has nothing yet, so it is a new line with lot and expiry.
  await page.getByRole("navigation", { name: "Inventory" }).getByRole("link", { name: "Stock count" }).click();
  await expect(page.getByRole("button", { name: "Post count" })).toBeVisible();
  await expect(page.locator('input[aria-label^="Product New "]').first()).toBeVisible();
  const lineIndex = await page.locator('input[aria-label^="Product New "]').evaluateAll((els, n) => els.findIndex((e) => (e as HTMLInputElement).value === n), name);
  expect(lineIndex).toBeGreaterThanOrEqual(0);
  await page.getByLabel(`Lot New ${lineIndex + 1}`).fill("G1");
  await page.getByLabel(`Expiry New ${lineIndex + 1}`).fill("2027-05-31");
  await page.getByLabel(`Counted New ${lineIndex + 1}`).fill("4");
  await page.getByRole("button", { name: "Post count" }).click();
  await expect(page.getByRole("status")).toContainText("Count posted");

  // Below its minimum: shown on the stock screen and the overview.
  await page.goto(`/inventory/stock?show=low&q=${encodeURIComponent(name)}`);
  const stockRow = page.getByRole("region", { name: "Stock" }).getByRole("row", { name: new RegExp(name) });
  await expect(stockRow).toContainText("4 piece");
  await expect(stockRow).toContainText("Below minimum");
  await page.goto("/inventory");
  await expect(page.getByRole("region", { name: "Reorder" })).toContainText(name);

  // A second count corrects only the difference.
  await page.goto("/inventory/stocktake");
  await page.getByLabel(`Counted ${name} G1`).fill("3");
  await expect(page.locator("tr", { has: page.getByLabel(`Counted ${name} G1`) })).toContainText("-1");
  await page.getByRole("button", { name: "Post count" }).click();
  await expect(page.getByRole("status")).toContainText("1 corrected");

  // The nurse sees stock but not the management screens.
  const nurseCtx = await browser.newContext();
  try {
    const nurse = await nurseCtx.newPage();
    await loginAs(nurse, "nurse");
    await nurse.goto("/inventory/stock");
    await expect(nurse.getByRole("region", { name: "Stock" })).toBeVisible();
    await expect(nurse.getByRole("link", { name: "الجرد" })).toHaveCount(0);
    expect((await nurse.goto("/inventory/stocktake"))?.status()).toBe(404);
  } finally {
    await nurseCtx.close();
  }
});
