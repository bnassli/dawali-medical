import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLogs, stockMovements, stockWriteOffs } from "@/db/schema";
import { todayIn } from "@/lib/age";
import { getEnv } from "@/lib/env";
import { addDays } from "@/modules/inventory/catalog";
import { listSuppliers, listWarehouses, receiveStock, stockLevels } from "@/modules/inventory/service";
import { lastSupplierByBatch, listWriteOffs, postWriteOff, WriteOffShortageError } from "@/modules/inventory/write-offs";
import { ForbiddenError } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import { createTestUser, openTestDb, uniqueSuffix } from "./helpers";

/** I5 (ADR-043): returns to the supplier and disposals. */
describe("Returns and disposals I5 (ADR-043)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let store: ActorContext;
  let nurse: ActorContext;
  let ops: string;
  let clinic: string;
  let today: string;

  beforeAll(async () => {
    ({ db, close } = openTestDb());
    store = (await createTestUser(db, { roleCode: "INVENTORY" })).actor;
    nurse = (await createTestUser(db, { roleCode: "NURSE_ASSISTANT" })).actor;
    const w = await listWarehouses(db, store);
    ops = w.find((x) => x.code === "operations")!.id;
    clinic = w.find((x) => x.code === "clinic")!.id;
    today = todayIn(getEnv().APP_TIME_ZONE);
  });
  afterAll(async () => close());

  /** An expired lot (bought at 10 per unit), a good lot, and an unpriced lot. */
  async function stock(s: string) {
    await receiveStock(db, store, {
      receiptId: randomUUID(),
      scanId: null,
      warehouseId: ops,
      supplierName: `Return supplier ${s}`,
      invoiceNumber: `R-${s}`,
      invoiceDate: today,
      lines: [
        { productName: `Foam ${s}`, unit: "vial", lotNumber: "OLD", expiryDate: addDays(today, -5), quantity: 2, packSize: 5, unitCost: 50 },
        { productName: `Foam ${s}`, unit: "vial", lotNumber: "NEW", expiryDate: addDays(today, 200), quantity: 4, packSize: 1, unitCost: 10 },
        { productName: `Swab ${s}`, unit: "box", lotNumber: "", expiryDate: null, quantity: 3, packSize: 1, unitCost: null },
      ],
    });
    const rows = (await stockLevels(db, store, ops)).filter((r) => r.productName.endsWith(s));
    const batch = (lot: string, product = `Foam ${s}`) => rows.find((r) => r.productName === product && r.lotNumber === lot)!.batchId;
    const supplierId = (await listSuppliers(db, store)).find((x) => x.name === `Return supplier ${s}`)!.id;
    return { batch, supplierId };
  }
  const balance = async (s: string, lot: string, product = "Foam") =>
    (await stockLevels(db, store, ops)).find((r) => r.productName === `${product} ${s}` && r.lotNumber === lot)?.quantity ?? 0;

  it("returns stock to the supplier: one document, negative movements, audited, value at invoice cost", async () => {
    const s = uniqueSuffix();
    const { batch, supplierId } = await stock(s);
    expect((await lastSupplierByBatch(db, store)).get(batch("OLD"))).toBe(supplierId);
    const id = randomUUID();
    const input = {
      id,
      kind: "supplier_return" as const,
      warehouseId: ops,
      supplierId,
      reason: "expired" as const,
      reference: `RMA-${s}`,
      notes: null,
      lines: [{ batchId: batch("OLD"), quantity: 10 }, { batchId: batch("NEW"), quantity: 1 }],
    };
    await expect(postWriteOff(db, store, input)).resolves.toEqual({ id, replayed: false, lines: 2 });
    await expect(postWriteOff(db, store, input)).resolves.toMatchObject({ replayed: true });
    expect(await balance(s, "OLD")).toBe(0);
    expect(await balance(s, "NEW")).toBe(3);

    const moves = await db.select().from(stockMovements).where(eq(stockMovements.writeOffId, id));
    expect(moves.map((m) => [m.movementType, Number(m.quantity), m.reason]).sort()).toEqual([
      ["supplier_return", -1, "expired"],
      ["supplier_return", -10, "expired"],
    ]);
    const doc = (await listWriteOffs(db, store)).find((w) => w.id === id)!;
    // 10 units at 50/5 = 10 each, 1 unit at 10.
    expect(doc).toMatchObject({ kind: "supplier_return", reason: "expired", supplierName: `Return supplier ${s}`, reference: `RMA-${s}`, value: 110, unpricedLines: 0 });
    expect(doc.lines).toHaveLength(2);
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "stock.write_off")));
    expect(audit).toHaveLength(1);
  });

  it("disposes of stock; a return needs a supplier; never more than the batch holds, and then nothing is recorded", async () => {
    const s = uniqueSuffix();
    const { batch } = await stock(s);
    const base = { kind: "disposal" as const, warehouseId: ops, supplierId: null, reason: "damaged" as const, reference: "", notes: "Box fell" };
    const short = await postWriteOff(db, store, { ...base, id: randomUUID(), lines: [{ batchId: batch("NEW"), quantity: 1 }, { batchId: batch("", `Swab ${s}`), quantity: 4 }] }).catch((e: unknown) => e);
    expect(short).toBeInstanceOf(WriteOffShortageError);
    expect(short).toMatchObject({ productName: `Swab ${s}`, available: 3, unit: "box" });
    expect(await balance(s, "NEW")).toBe(4);
    // Not in the Clinic store at all.
    await expect(postWriteOff(db, store, { ...base, id: randomUUID(), warehouseId: clinic, lines: [{ batchId: batch("NEW"), quantity: 1 }] })).rejects.toBeInstanceOf(WriteOffShortageError);
    await expect(postWriteOff(db, store, { ...base, id: randomUUID(), kind: "supplier_return", lines: [{ batchId: batch("NEW"), quantity: 1 }] })).rejects.toThrow(/supplier/);
    await expect(postWriteOff(db, store, { ...base, id: randomUUID(), lines: [{ batchId: batch("NEW"), quantity: 1 }, { batchId: batch("NEW"), quantity: 1 }] })).rejects.toThrow(/twice/);

    const id = randomUUID();
    await postWriteOff(db, store, { ...base, id, lines: [{ batchId: batch("", `Swab ${s}`), quantity: 3 }] });
    expect(await balance(s, "", "Swab")).toBe(0);
    const doc = (await listWriteOffs(db, store)).find((w) => w.id === id)!;
    expect(doc).toMatchObject({ kind: "disposal", reason: "damaged", supplierName: null, reference: null, notes: "Box fell", value: 0, unpricedLines: 1 });
  });

  it("documents are append-only, and only the storekeeper may record or see them", async () => {
    const s = uniqueSuffix();
    const { batch } = await stock(s);
    const id = randomUUID();
    const input = { id, kind: "disposal" as const, warehouseId: ops, supplierId: null, reason: "recalled" as const, reference: null, notes: null, lines: [{ batchId: batch("NEW"), quantity: 1 }] };
    await expect(postWriteOff(db, nurse, input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listWriteOffs(db, nurse)).rejects.toBeInstanceOf(ForbiddenError);
    await postWriteOff(db, store, input);
    await expect(db.execute(sql`UPDATE stock_write_offs SET notes = 'x' WHERE id = ${id}`)).rejects.toThrow();
    await expect(db.delete(stockWriteOffs).where(eq(stockWriteOffs.id, id))).rejects.toThrow();
  });
});
