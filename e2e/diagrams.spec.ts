import { expect, test, type Page } from "@playwright/test";
import { createVisitFixture, loginAs, visitUrl } from "./support";

/** R4 (ADR-033): Create Leg / Vein Diagram, draw, save versions, private files. */

async function draw(page: Page, from: [number, number], to: [number, number]) {
  const box = await page.getByLabel(/drawing area/).boundingBox();
  if (!box) throw new Error("canvas not visible");
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * ((from[0] + to[0]) / 2), box.y + box.height * ((from[1] + to[1]) / 2), { steps: 5 });
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 5 });
  await page.mouse.up();
}

test("Create Leg Diagram, draw, save v1, reopen, save v2; files are served only to clinical users", async ({ page, browser }) => {
  const visit = await createVisitFixture();
  await loginAs(page, "doctor");
  await page.goto(visitUrl(visit));
  const panel = page.getByRole("region", { name: "Diagrams" });
  await expect(panel.getByText("No diagrams saved for this visit.")).toBeVisible();

  await panel.getByRole("link", { name: "Create Leg Diagram" }).click();
  await expect(page.getByRole("heading", { name: "Leg Diagram" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled(); // nothing drawn yet
  await draw(page, [0.2, 0.3], [0.3, 0.6]);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await page.getByRole("button", { name: "Redo" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("diagram-version")).toHaveText("Version 1");
  await expect(page.getByText(/Saved version 1 \(.*_LegDiagram_v01\.png\)/)).toBeVisible();

  const diagramUrl = page.url().split("?")[0] ?? "";
  await page.goto(diagramUrl); // reopen: continues from v1
  await expect(page.getByTestId("diagram-version")).toHaveText("Version 1");
  await page.getByRole("button", { name: "Blue" }).click();
  await draw(page, [0.6, 0.3], [0.7, 0.7]);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("diagram-version")).toHaveText("Version 2");

  await page.getByRole("link", { name: "Back to visit" }).click();
  const files = page.getByRole("region", { name: "Diagrams" }).getByRole("link", { name: /_LegDiagram_v0[12]\.png$/ });
  await expect(files).toHaveCount(2);
  const href = (await files.first().getAttribute("href")) ?? "";
  const res = await page.request.get(href);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("image/png");
  expect((await res.body()).subarray(1, 4).toString()).toBe("PNG");

  const receptionCtx = await browser.newContext();
  try {
    const reception = await receptionCtx.newPage();
    await loginAs(reception, "reception");
    expect((await reception.request.get(href)).status()).toBe(403);
    await reception.goto(visitUrl(visit));
    await expect(reception.getByRole("region", { name: "Diagrams" })).toHaveCount(0);
    expect((await receptionCtx.request.get(href, { headers: { cookie: "" } })).status()).toBeGreaterThanOrEqual(401);
  } finally {
    await receptionCtx.close();
  }
});

test("Create Vein Diagram is a separate diagram with its own template", async ({ page }) => {
  const visit = await createVisitFixture();
  await loginAs(page, "doctor");
  await page.goto(visitUrl(visit));
  await page.getByRole("region", { name: "Diagrams" }).getByRole("link", { name: "Create Vein Diagram" }).click();
  await expect(page.getByRole("heading", { name: "Vein Diagram" })).toBeVisible();
  await draw(page, [0.4, 0.4], [0.5, 0.5]);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("diagram-version")).toHaveText("Version 1");
  await page.getByRole("link", { name: "Back to visit" }).click();
  const panel = page.getByRole("region", { name: "Diagrams" });
  await expect(panel.getByRole("link", { name: /_VeinDiagram_v01\.png$/ })).toHaveCount(1);
  await expect(panel.getByRole("link", { name: /_LegDiagram_/ })).toHaveCount(0);
});
