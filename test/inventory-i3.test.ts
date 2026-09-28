import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLogs, stockCountLines, stockMovements } from "@/db/schema";
import {
  countSheet,
  inventorySummary,
  listCatalog,
  postStockCount,
  saveProduct,
  stockOverview,
  stockStatus,
} from "@/modules/inventory/catalog";
import { DICTS, fill, parseLang } from "@/modules/inventory/i18n";
import { InventoryError, listWarehouses, receiveStock, stockLevels } from "@/modules/inventory/service";
import { ForbiddenError } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import { createTestUser, openTestDb, uniqueSuffix } from "./helpers";

/** I3 (ADR-038): catalogue, overview, stock counts, bilingual labels. */
describe("Inventory I3 (ADR-038)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let store: ActorContext;
  let nurse: ActorContext;
  let ops: string;
  const today = "2026-09-28";

  beforeAll(async () => {
    ({ db, close } = openTestDb());
    store = (await createTestUser(db, { roleCode: "INVENTORY" })).actor;
    nurse = (await createTestUser(db, { roleCode: "NURSE_ASSISTANT" })).actor;
    ops = (await listWarehouses(db, store)).find((w) => w.code === "operations")!.id;
  });
  afterAll(async () => close());

  const product = (s: string, extra: Partial<Parameters<typeof saveProduct>[2]> = {}) => ({
    id: null,
    name: `Gauze ${s}`,
    unit: "piece",
    category: "Dressings",
    minLevel: 10,
    barcode: "",
    isActive: true,
    ...extra,
  });
  const balance = async (name: string) =>
    (await stockLevels(db, store, ops)).filter((r) => r.productName === name).reduce((n, r) => n + r.quantity, 0);

  it("creates and edits catalogue products (audited); names and barcodes are unique", async () => {
    const s = uniqueSuffix();
    const { id } = await saveProduct(db, store, product(s, { barcode: `BC${s}` }));
    await saveProduct(db, store, { ...product(s, { barcode: `BC${s}` }), id, minLevel: 20, category: "" });
    const saved = (await listCatalog(db, store)).find((p) => p.id === id)!;
    expect(saved).toMatchObject({ name: `Gauze ${s}`, minLevel: 20, category: null, barcode: `BC${s}`, total: 0, hasMovements: false });

    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "inventory_product.update")));
    expect(audit).toHaveLength(1);

    await expect(saveProduct(db, store, product(s, { name: `gauze ${s}` }))).rejects.toMatchObject({ key: "duplicateName" });
    await expect(saveProduct(db, store, product(`${s}b`, { barcode: `BC${s}` }))).rejects.toMatchObject({ key: "duplicateBarcode" });
    await expect(saveProduct(db, store, product(s, { minLevel: -1 }))).rejects.toThrow();
    await expect(saveProduct(db, nurse, product(`${s}c`))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the unit is locked once stock has moved", async () => {
    const s = uniqueSuffix();
    const { id } = await saveProduct(db, store, product(s));
    await saveProduct(db, store, { ...product(s), id, unit: "pack" }); // no movements yet: allowed
    await receiveStock(db, store, {
      receiptId: randomUUID(), scanId: null, warehouseId: ops, supplierName: `Sup ${s}`, invoiceNumber: `I-${s}`, invoiceDate: "2026-09-01",
      lines: [{ productName: `Gauze ${s}`, unit: "pack", lotNumber: "G1", expiryDate: "2027-01-01", quantity: 3, packSize: 1, unitCost: null }],
    });
    const err = await saveProduct(db, store, { ...product(s), id, unit: "piece" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InventoryError);
    expect((err as InventoryError).key).toBe("unitLocked");
  });

  it("opening count creates products and batches; later counts post only the differences", async () => {
    const s = uniqueSuffix();
    const name = `Syringe ${s}`;
    const first = await postStockCount(db, store, {
      countId: randomUUID(), warehouseId: ops, notes: "Opening",
      lines: [
        { batchId: null, productName: name, unit: "piece", lotNumber: "S1", expiryDate: "2027-03-31", countedQuantity: 40 },
        { batchId: null, productName: name, unit: "piece", lotNumber: "S2", expiryDate: "2026-10-15", countedQuantity: 5 },
      ],
    });
    expect(first).toEqual({ lines: 2, changes: 2, replayed: false });
    expect(await balance(name)).toBe(45);

    const sheet = await countSheet(db, store, ops);
    const mine = sheet.batches.filter((b) => b.productName === name);
    expect(mine.map((b) => [b.lotNumber, b.quantity])).toEqual([["S2", 5], ["S1", 40]]); // earliest expiry first
    expect(sheet.emptyProducts.some((p) => p.name === name)).toBe(false);

    const countId = randomUUID();
    const input = {
      countId, warehouseId: ops, notes: "",
      lines: [
        { batchId: mine[0]!.batchId, productName: "", unit: "", lotNumber: "", expiryDate: null, countedQuantity: 5 },
        { batchId: mine[1]!.batchId, productName: "", unit: "", lotNumber: "", expiryDate: null, countedQuantity: 37 },
      ],
    };
    expect(await postStockCount(db, store, input)).toEqual({ lines: 2, changes: 1, replayed: false });
    expect(await balance(name)).toBe(42);
    // Replaying the same count changes nothing.
    expect((await postStockCount(db, store, input)).replayed).toBe(true);
    expect(await balance(name)).toBe(42);

    const lines = await db.select().from(stockCountLines).where(eq(stockCountLines.countId, countId));
    expect(lines.map((l) => [Number(l.systemQuantity), Number(l.countedQuantity)]).sort()).toEqual([[40, 37], [5, 5]]);
    const moves = await db.select().from(stockMovements).where(eq(stockMovements.countId, countId));
    expect(moves.map((m) => [m.movementType, Number(m.quantity)])).toEqual([["stock_count", -3]]);
    expect(await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, countId), eq(auditLogs.action, "stock.count")))).toHaveLength(1);

    // Counts are append-only.
    await expect(db.execute(sql`UPDATE stock_count_lines SET counted_quantity = 0 WHERE count_id = ${countId}`)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining("append-only") }),
    });
  });

  it("refuses a negative count, a batch counted twice, incomplete new lines, and non-managers", async () => {
    const s = uniqueSuffix();
    const line = { batchId: null, productName: `Tape ${s}`, unit: "roll", lotNumber: "T1", expiryDate: null, countedQuantity: 2 };
    const base = { countId: randomUUID(), warehouseId: ops, notes: "" };
    await expect(postStockCount(db, store, { ...base, lines: [{ ...line, countedQuantity: -1 }] })).rejects.toThrow();
    await expect(postStockCount(db, store, { ...base, lines: [line, line] })).rejects.toMatchObject({ key: "countDuplicate" });
    await expect(postStockCount(db, store, { ...base, lines: [{ ...line, unit: "" }] })).rejects.toMatchObject({ key: "countLineIncomplete" });
    await expect(postStockCount(db, nurse, { ...base, lines: [line] })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await balance(`Tape ${s}`)).toBe(0);
  });

  it("overview: status against the minimum level, filters, expiring batches", async () => {
    const s = uniqueSuffix();
    await saveProduct(db, store, product(s, { name: `Low ${s}`, minLevel: 10 }));
    await saveProduct(db, store, product(s, { name: `Out ${s}`, minLevel: 5 }));
    await postStockCount(db, store, {
      countId: randomUUID(), warehouseId: ops, notes: "",
      lines: [
        { batchId: null, productName: `Low ${s}`, unit: "piece", lotNumber: "L", expiryDate: "2026-10-20", countedQuantity: 4 },
        { batchId: null, productName: `Plenty ${s}`, unit: "piece", lotNumber: "P", expiryDate: "2026-09-01", countedQuantity: 100 },
      ],
    });
    const all = await stockOverview(db, store, { warehouseId: ops, q: s, today });
    const by = new Map(all.map((p) => [p.name, p]));
    expect(by.get(`Low ${s}`)?.status).toBe("low");
    expect(by.get(`Out ${s}`)?.status).toBe("out");
    expect(by.get(`Plenty ${s}`)?.status).toBe("ok");
    expect((await stockOverview(db, store, { warehouseId: ops, q: s, filter: "low", today })).map((p) => p.name)).toEqual([`Low ${s}`]);
    expect((await stockOverview(db, store, { warehouseId: ops, q: s, filter: "expiring", today })).map((p) => p.name).sort()).toEqual([`Low ${s}`, `Plenty ${s}`]);

    const summary = await inventorySummary(db, store, today);
    expect(summary.low.some((p) => p.name === `Out ${s}`)).toBe(true);
    const expired = summary.expiring.find((b) => b.productName === `Plenty ${s}`);
    expect(expired?.expiryDate).toBe("2026-09-01");
    expect(summary.expiredCount).toBeGreaterThanOrEqual(1);
    expect(summary.movements.length).toBeGreaterThan(0);
    // The nurse can read the overview (she needs stock to record usage).
    await expect(inventorySummary(db, nurse, today)).resolves.toBeTruthy();
  });

  it("status rules and bilingual labels", () => {
    expect(stockStatus(0, 5)).toBe("out");
    expect(stockStatus(5, 5)).toBe("low");
    expect(stockStatus(6, 5)).toBe("ok");
    expect(stockStatus(1, null)).toBe("ok");
    expect(parseLang("en")).toBe("en");
    expect(parseLang("fr")).toBe("ar");
    expect(Object.keys(DICTS.ar).sort()).toEqual(Object.keys(DICTS.en).sort());
    expect(Object.values(DICTS.ar).every((v) => v.trim() !== "")).toBe(true);
    expect(fill(DICTS.ar.notEnough, { n: 3, unit: "vial" })).toBe("الرصيد غير كافٍ: المتوفر 3 vial فقط في هذا المستودع.");
  });
});
