import { expect, test } from "@playwright/test";
import { createVisitFixture, loginAs, uniq, visitUrl } from "./support";

/** I1 (ADR-035): scan -> review -> receive; nurse records usage on patient + doctor. */

test("storekeeper receives a scanned invoice (reviewed), nurse charges usage to patient and doctor", async ({ page, browser }) => {
  const s = uniq();
  const product = `Polidocanol ${s}`;
  await loginAs(page, "store");
  await page.goto("/inventory");
  await expect(page.getByRole("navigation", { name: "Stores" }).locator(".tab.active")).toContainText("Operations Store");

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
  await page.reload();
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
  await expect(page.getByRole("region", { name: "Materials used by doctor" })).toContainText(`${product} (vial): 2`);
});

test("materials-used report: storekeeper filters and exports to Excel; nurse has no access", async ({ page, browser }) => {
  await loginAs(page, "store");
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
