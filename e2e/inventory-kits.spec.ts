import { expect, test, type Page } from "@playwright/test";
import { createVisitFixture, loginAs, uniq, visitUrl } from "./support";

async function english(page: Page) {
  await page.context().addCookies([{ name: "inv_lang", value: "en", url: "http://localhost:3100" }]);
}
const dmy = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10).split("-").reverse().join("/");

/** I4 (ADR-042): the storekeeper sets up a kit; the nurse records it on the visit in one step. */
test("procedure kit: set up by the storekeeper, recorded by the nurse in one step (FEFO, editable quantities)", async ({ page, browser }) => {
  const s = uniq();
  const fibre = `Kit fibre ${s}`;
  const gel = `Kit gel ${s}`;
  const kit = `EVLT ${s}`;
  await loginAs(page, "store");
  await english(page);

  // Stock: the fibre in two lots (the one expiring first is used first), gel in one.
  await page.goto("/inventory/receive");
  await page.getByLabel("Supplier").fill(`Kit supplier ${s}`);
  await page.getByLabel("Invoice number").fill(`KIT-${s}`);
  await page.getByLabel("Invoice date").fill(dmy(0));
  await page.getByRole("button", { name: "+ Add line" }).click();
  await page.getByRole("button", { name: "+ Add line" }).click();
  for (const [i, name, lot, days, qty] of [[1, fibre, "LATE", 300, 5], [2, fibre, "EARLY", 100, 1], [3, gel, "G1", 200, 4]] as const) {
    await page.getByLabel(`Product ${i}`).fill(name);
    await page.getByLabel(`Unit ${i}`).fill("piece");
    await page.getByLabel(`Lot ${i}`).fill(lot);
    await page.getByLabel(`Expiry ${i}`).fill(dmy(days));
    await page.getByLabel(`Quantity ${i}`).fill(String(qty));
  }
  await page.getByRole("button", { name: "Confirm and add to stock" }).click();
  await expect(page.getByText(`Invoice KIT-${s} received into stock.`)).toBeVisible();

  // The kit.
  await page.getByRole("navigation", { name: "Inventory" }).getByRole("link", { name: "Procedure kits" }).click();
  await page.getByRole("button", { name: "+ New kit" }).click();
  const form = page.getByRole("group", { name: "New kit" });
  await form.getByLabel("Kit name").fill(kit);
  await form.getByLabel("Product 1").selectOption({ label: `${fibre} (piece)` });
  await form.getByLabel("Quantity 1").fill("1");
  await form.getByRole("button", { name: "+ Add item" }).click();
  await form.getByLabel("Product 2").selectOption({ label: `${gel} (piece)` });
  await form.getByLabel("Quantity 2").fill("1");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");
  const card = page.getByRole("article", { name: kit });
  await expect(card).toContainText(`${fibre} — 1 piece`);
  await expect(card).toContainText(`${gel} — 1 piece`);

  const visit = await createVisitFixture();
  const nurseCtx = await browser.newContext();
  try {
    const nurse = await nurseCtx.newPage();
    await loginAs(nurse, "nurse");
    await nurse.goto(visitUrl(visit));
    const panel = nurse.getByRole("region", { name: "Materials used" });
    await panel.getByLabel("Doctor").selectOption({ label: "E2E doctor" });
    await panel.getByLabel("Procedure kit", { exact: true }).selectOption({ label: kit });
    const items = panel.getByRole("table", { name: "Kit items" });
    await expect(items.getByRole("row", { name: new RegExp(fibre) })).toContainText(`lot EARLY (exp ${dmy(100)}) × 1`);
    // This case used two fibres: the earliest lot runs out, the rest comes from the next one.
    await panel.getByLabel(`Kit quantity ${fibre}`).fill("2");
    await expect(items.getByRole("row", { name: new RegExp(fibre) })).toContainText(`lot EARLY (exp ${dmy(100)}) × 1, lot LATE (exp ${dmy(300)}) × 1`);
    // More than the store holds: shown before recording, and the button is off.
    await panel.getByLabel(`Kit quantity ${gel}`).fill("9");
    await expect(items.getByRole("row", { name: new RegExp(gel) })).toContainText("Not enough usable stock in this store (5 piece missing).");
    await expect(panel.getByRole("button", { name: "Record kit (2 items)" })).toBeDisabled();
    await panel.getByLabel(`Kit quantity ${gel}`).fill("1");
    await panel.getByRole("button", { name: "Record kit (2 items)" }).click();
    await expect(panel.getByRole("status")).toHaveText("Recorded 3 lines.");
    await expect(panel.getByText(new RegExp(`1 piece ${fibre} \\(lot EARLY\\) — Dr\\. E2E doctor, .*\\(kit ${kit}\\)`))).toBeVisible();
    await expect(panel.getByText(new RegExp(`1 piece ${fibre} \\(lot LATE\\)`))).toBeVisible();
    await expect(panel.getByText(new RegExp(`1 piece ${gel} \\(lot G1\\)`))).toBeVisible();
  } finally {
    await nurseCtx.close();
  }

  await page.goto(`/inventory/stock?q=${encodeURIComponent(s)}`);
  const stock = page.getByRole("region", { name: "Stock" });
  await expect(stock.getByRole("row", { name: new RegExp(fibre) }).first()).toContainText("4 piece");
  await expect(stock.getByRole("row", { name: new RegExp(gel) }).first()).toContainText("3 piece");
});
