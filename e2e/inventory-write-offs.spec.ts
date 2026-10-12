import { expect, test, type Page } from "@playwright/test";
import { loginAs, uniq } from "./support";

async function english(page: Page) {
  await page.context().addCookies([{ name: "inv_lang", value: "en", url: "http://localhost:3100" }]);
}
const dmy = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10).split("-").reverse().join("/");

/** I5 (ADR-043): expired stock disposed of in one step; a damaged box returned to its supplier. */
test("returns & disposal: dispose of everything expired, return a batch to its supplier", async ({ page }) => {
  const s = uniq();
  const product = `WO gel ${s}`;
  await loginAs(page, "store");
  await english(page);

  await page.goto("/inventory/receive");
  await page.getByLabel("Supplier").fill(`WO supplier ${s}`);
  await page.getByLabel("Invoice number").fill(`WO-${s}`);
  await page.getByLabel("Invoice date").fill(dmy(-200));
  await page.getByRole("button", { name: "+ Add line" }).click();
  for (const [i, lot, days, qty] of [[1, "EXP", -3, 4], [2, "GOOD", 300, 6]] as const) {
    await page.getByLabel(`Product ${i}`).fill(product);
    await page.getByLabel(`Unit ${i}`).fill("tube");
    await page.getByLabel(`Lot ${i}`).fill(lot);
    await page.getByLabel(`Expiry ${i}`).fill(dmy(days));
    await page.getByLabel(`Quantity ${i}`).fill(String(qty));
    await page.getByLabel(`Unit cost ${i}`).fill("10");
  }
  await page.getByRole("button", { name: "Confirm and add to stock" }).click();
  await expect(page.getByText(`Invoice WO-${s} received into stock.`)).toBeVisible();

  // Disposal: everything expired in the Operations store, in one click.
  await page.getByRole("navigation", { name: "Inventory" }).getByRole("link", { name: "Returns & disposal" }).click();
  const form = page.getByRole("region", { name: "Return to supplier or dispose" });
  await form.getByRole("button", { name: "+ Add everything expired in this store" }).click();
  const expiredLine = form.locator("tr", { has: page.locator("option:checked", { hasText: product }) });
  await expect(expiredLine).toHaveCount(1);
  await expect(expiredLine).toContainText("of 4 tube");
  await expect(expiredLine).toHaveClass(/inv-expired/);
  await expect(form.getByLabel("Reason")).toHaveValue("expired");
  // Other tests' expired stock may be listed too; keep only ours.
  for (let i = (await form.locator("tbody tr").count()) - 1; i >= 0; i--) {
    const row = form.locator("tbody tr").nth(i);
    if (!((await row.locator("option:checked").textContent()) ?? "").includes(product)) await row.getByRole("button", { name: /Remove line/ }).click();
  }
  await form.getByRole("button", { name: "Confirm and take out of stock" }).click();
  await expect(form.getByRole("status")).toHaveText("Recorded: 1 lines taken out of stock.");

  // Return: 2 of the good lot; the supplier is suggested from the invoice.
  await form.getByLabel("Type").selectOption("supplier_return");
  const good = form.getByLabel("Batch 1").locator("option", { hasText: `${product} · Lot GOOD` });
  await form.getByLabel("Batch 1").selectOption((await good.getAttribute("value"))!);
  await expect(form.getByLabel("Supplier")).toHaveValue(/.+/);
  await expect(form.getByLabel("Supplier").locator("option:checked")).toHaveText(`WO supplier ${s}`);
  await form.getByLabel("Reason").selectOption("damaged");
  await form.getByLabel("Quantity 1").fill("9");
  await form.getByLabel("Reference no.").fill(`RMA-${s}`);
  await form.getByRole("button", { name: "Confirm and take out of stock" }).click();
  await expect(form.getByRole("alert")).toHaveText(`Not enough ${product} (lot GOOD) in this store: only 6 tube. Nothing was recorded.`);
  await form.getByLabel("Quantity 1").fill("2");
  await form.getByRole("button", { name: "Confirm and take out of stock" }).click();
  await expect(form.getByRole("status")).toHaveText("Recorded: 1 lines taken out of stock.");

  const history = page.getByRole("region", { name: "Latest returns and disposals" });
  await expect(history.getByRole("row", { name: new RegExp(`RMA-${s}`) })).toContainText(`Return to supplier`);
  await expect(history.getByRole("row", { name: new RegExp(`RMA-${s}`) })).toContainText(`${product} — 2 tube · Lot GOOD`);
  await expect(history.getByRole("row", { name: new RegExp(`RMA-${s}`) })).toContainText("20.00");
  await expect(history.getByRole("row", { name: new RegExp(`${product} — 4 tube · Lot EXP`) })).toContainText("Disposal");

  await page.goto(`/inventory/stock?q=${encodeURIComponent(product)}`);
  await expect(page.getByRole("region", { name: "Stock" }).getByRole("row", { name: new RegExp(product) }).first()).toContainText("4 tube");
});
