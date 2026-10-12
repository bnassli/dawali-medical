import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLogs, stockMovements, visits } from "@/db/schema";
import { todayIn } from "@/lib/age";
import { getEnv } from "@/lib/env";
import { VisitNotOpenError } from "@/modules/clinical/service";
import { addDays } from "@/modules/inventory/catalog";
import { allocateFefo } from "@/modules/inventory/fefo";
import { issueToVisit, KitShortageError, listKits, saveKit } from "@/modules/inventory/kits";
import { InventoryError, listWarehouses, receiveStock, stockLevels, visitConsumption } from "@/modules/inventory/service";
import { createPatient } from "@/modules/patients/service";
import { ForbiddenError } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import { createVisit } from "@/modules/visits/service";
import { createTestUser, openTestDb, uniqueSuffix } from "./helpers";

describe("FEFO allocation (ADR-042)", () => {
  const today = "2026-10-12";
  it("takes the earliest expiry first, skips expired batches, no-expiry batches last", () => {
    const batches = [
      { batchId: "c", expiryDate: null, quantity: 10 },
      { batchId: "b", expiryDate: "2027-01-01", quantity: 2 },
      { batchId: "a", expiryDate: "2026-11-01", quantity: 1.5 },
      { batchId: "x", expiryDate: "2026-10-11", quantity: 50 },
    ];
    expect(allocateFefo(batches, 5, today)).toEqual({
      takes: [{ batchId: "a", quantity: 1.5 }, { batchId: "b", quantity: 2 }, { batchId: "c", quantity: 1.5 }],
      short: 0,
    });
    expect(allocateFefo(batches, 1, today).takes).toEqual([{ batchId: "a", quantity: 1 }]);
    expect(allocateFefo([{ batchId: "t", expiryDate: today, quantity: 1 }], 1, today).short).toBe(0);
    expect(allocateFefo(batches, 20, today).short).toBe(6.5);
  });
});

describe("Procedure kits I4 (ADR-042)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let store: ActorContext;
  let nurse: ActorContext;
  let doctor: ActorContext;
  let ops: string;
  let clinic: string;
  let today: string;

  beforeAll(async () => {
    ({ db, close } = openTestDb());
    store = (await createTestUser(db, { roleCode: "INVENTORY" })).actor;
    nurse = (await createTestUser(db, { roleCode: "NURSE_ASSISTANT" })).actor;
    doctor = (await createTestUser(db, { roleCode: "DOCTOR" })).actor;
    const w = await listWarehouses(db, store);
    ops = w.find((x) => x.code === "operations")!.id;
    clinic = w.find((x) => x.code === "clinic")!.id;
    today = todayIn(getEnv().APP_TIME_ZONE);
  });
  afterAll(async () => close());

  async function openVisit() {
    const p = await createPatient(db, doctor, {
      firstName: `Kit${uniqueSuffix()}`,
      lastName: "Patient",
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });
    return (await createVisit(db, doctor, { patientId: p.id, reason: undefined })).id;
  }

  /** Two products in the Operations store: a fibre in two lots (+ one expired), and gel. */
  async function stock(s: string) {
    await receiveStock(db, store, {
      receiptId: randomUUID(),
      scanId: null,
      warehouseId: ops,
      supplierName: `Kit supplier ${s}`,
      invoiceNumber: `K-${s}`,
      invoiceDate: today,
      lines: [
        { productName: `Fibre ${s}`, unit: "piece", lotNumber: "LATE", expiryDate: addDays(today, 300), quantity: 5, packSize: 1, unitCost: 100 },
        { productName: `Fibre ${s}`, unit: "piece", lotNumber: "SOON", expiryDate: addDays(today, 20), quantity: 1, packSize: 1, unitCost: 100 },
        { productName: `Fibre ${s}`, unit: "piece", lotNumber: "OLD", expiryDate: addDays(today, -2), quantity: 9, packSize: 1, unitCost: 100 },
        { productName: `Gel ${s}`, unit: "tube", lotNumber: "G", expiryDate: null, quantity: 3, packSize: 1, unitCost: 5 },
      ],
    });
    const rows = (await stockLevels(db, store, ops)).filter((r) => r.productName.endsWith(s));
    const productId = (name: string) => rows.find((r) => r.productName === name)!.productId;
    return { fibre: productId(`Fibre ${s}`), gel: productId(`Gel ${s}`), lot: (lot: string) => rows.find((r) => r.lotNumber === lot && r.productName === `Fibre ${s}`)! };
  }

  const balance = async (s: string, lot: string) =>
    (await stockLevels(db, store, ops)).find((r) => r.productName.endsWith(s) && r.lotNumber === lot)?.quantity ?? 0;

  it("the storekeeper creates and edits a kit (audited); a stale edit and a duplicate name are refused", async () => {
    const s = uniqueSuffix();
    const p = await stock(s);
    const id = randomUUID();
    const input = { id, expectedUpdatedAt: null, name: `EVLT ${s}`, isActive: true, items: [{ productId: p.fibre, quantity: 1 }, { productId: p.gel, quantity: 1 }] };
    await expect(saveKit(db, store, input)).resolves.toEqual({ id, replayed: false });
    await expect(saveKit(db, store, input)).resolves.toEqual({ id, replayed: true });
    const kit = (await listKits(db, nurse)).find((k) => k.id === id)!;
    expect(kit.items.map((i) => [i.productName, i.quantity])).toEqual([[`Fibre ${s}`, 1], [`Gel ${s}`, 1]]);

    await saveKit(db, store, { ...input, expectedUpdatedAt: kit.updatedAt, items: [{ productId: p.gel, quantity: 2 }, { productId: p.fibre, quantity: 1 }] });
    const edited = (await listKits(db, store)).find((k) => k.id === id)!;
    expect(edited.items.map((i) => [i.productName, i.quantity])).toEqual([[`Gel ${s}`, 2], [`Fibre ${s}`, 1]]);
    await expect(saveKit(db, store, { ...input, expectedUpdatedAt: kit.updatedAt })).rejects.toMatchObject({ key: "kitConflict" });
    await expect(saveKit(db, store, { ...input, id: randomUUID(), name: `evlt ${s}` })).rejects.toMatchObject({ key: "duplicateKitName" });
    await expect(saveKit(db, store, { ...input, id: randomUUID(), name: `Twice ${s}`, items: [{ productId: p.gel, quantity: 1 }, { productId: p.gel, quantity: 1 }] })).rejects.toThrow(/twice/);
    await expect(saveKit(db, nurse, { ...input, id: randomUUID(), name: `Nurse ${s}` })).rejects.toBeInstanceOf(ForbiddenError);

    const audit = await db.select().from(auditLogs).where(eq(auditLogs.entityId, id));
    expect(audit.map((a) => a.action).sort()).toEqual(["procedure_kit.create", "procedure_kit.update"]);

    await saveKit(db, store, { ...input, expectedUpdatedAt: edited.updatedAt, isActive: false });
    expect((await listKits(db, nurse, { activeOnly: true })).some((k) => k.id === id)).toBe(false);
  });

  it("the nurse records a kit in one step: FEFO across lots, never an expired lot, kit kept on each line", async () => {
    const s = uniqueSuffix();
    const p = await stock(s);
    const kitId = randomUUID();
    await saveKit(db, store, { id: kitId, expectedUpdatedAt: null, name: `Kit ${s}`, isActive: true, items: [{ productId: p.fibre, quantity: 2 }, { productId: p.gel, quantity: 1 }] });
    const visitId = await openVisit();
    const clientMutationId = randomUUID();
    const issue = { clientMutationId, visitId, warehouseId: ops, doctorId: doctor.userId, kitId, items: [{ productId: p.fibre, quantity: 2 }, { productId: p.gel, quantity: 1 }] };
    const r = await issueToVisit(db, nurse, issue);
    expect(r.replayed).toBe(false);
    expect(r.lines.map((l) => [l.productName, l.lotNumber, l.quantity]).sort()).toEqual([
      [`Fibre ${s}`, "LATE", 1],
      [`Fibre ${s}`, "SOON", 1],
      [`Gel ${s}`, "G", 1],
    ]);
    await expect(issueToVisit(db, nurse, issue)).resolves.toMatchObject({ replayed: true });
    expect(await balance(s, "SOON")).toBe(0);
    expect(await balance(s, "LATE")).toBe(4);
    expect(await balance(s, "OLD")).toBe(9);

    const used = await visitConsumption(db, nurse, visitId);
    expect(used).toHaveLength(3);
    expect(used.every((u) => u.kitName === `Kit ${s}` && u.doctorName !== null)).toBe(true);
    const moves = await db.select().from(stockMovements).where(eq(stockMovements.clientMutationId, clientMutationId));
    expect(moves.every((m) => m.kitId === kitId && m.movementType === "consumption" && m.visitId === visitId)).toBe(true);
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.visitId, visitId), eq(auditLogs.action, "stock.consume_kit")));
    expect(audit).toHaveLength(1);
  });

  it("all or nothing: a shortage of one item records nothing; quantities can be changed for the case", async () => {
    const s = uniqueSuffix();
    const p = await stock(s);
    const visitId = await openVisit();
    const base = { visitId, warehouseId: ops, doctorId: doctor.userId, kitId: null };
    // 7 fibres wanted, 6 usable (the 9 expired do not count).
    const err = await issueToVisit(db, nurse, { ...base, clientMutationId: randomUUID(), items: [{ productId: p.gel, quantity: 1 }, { productId: p.fibre, quantity: 7 }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KitShortageError);
    expect((err as KitShortageError).shortages).toEqual([{ productName: `Fibre ${s}`, unit: "piece", needed: 7, available: 6 }]);
    expect(await visitConsumption(db, nurse, visitId)).toHaveLength(0);
    expect(await balance(s, "G")).toBe(3);
    // Not in this store at all.
    await expect(issueToVisit(db, nurse, { ...base, warehouseId: clinic, clientMutationId: randomUUID(), items: [{ productId: p.gel, quantity: 1 }] })).rejects.toBeInstanceOf(KitShortageError);
    // The same product on two lines is one need.
    await issueToVisit(db, nurse, { ...base, clientMutationId: randomUUID(), items: [{ productId: p.gel, quantity: 1.5 }, { productId: p.gel, quantity: 1.5 }] });
    expect(await balance(s, "G")).toBe(0);
  });

  it("two identical requests at once (double click, retry) record the kit once", async () => {
    const s = uniqueSuffix();
    const p = await stock(s);
    const visitId = await openVisit();
    // One fibre: the first request empties lot SOON, so a second one would move on to LATE.
    const issue = { clientMutationId: randomUUID(), visitId, warehouseId: ops, doctorId: doctor.userId, kitId: null, items: [{ productId: p.fibre, quantity: 1 }] };
    const results = await Promise.all([issueToVisit(db, nurse, issue), issueToVisit(db, nurse, issue), issueToVisit(db, nurse, issue)]);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await visitConsumption(db, nurse, visitId)).toHaveLength(1);
    expect(await balance(s, "SOON")).toBe(0);
    expect(await balance(s, "LATE")).toBe(5);
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.visitId, visitId), eq(auditLogs.action, "stock.consume_kit")));
    expect(audit).toHaveLength(1);
  });

  it("checks the doctor, an open visit, an active kit and the nurse's permission", async () => {
    const s = uniqueSuffix();
    const p = await stock(s);
    const kitId = randomUUID();
    await saveKit(db, store, { id: kitId, expectedUpdatedAt: null, name: `Old kit ${s}`, isActive: false, items: [{ productId: p.gel, quantity: 1 }] });
    const visitId = await openVisit();
    const issue = (extra: object = {}) => ({ clientMutationId: randomUUID(), visitId, warehouseId: ops, doctorId: doctor.userId, kitId: null, items: [{ productId: p.gel, quantity: 1 }], ...extra });
    await expect(issueToVisit(db, nurse, issue({ doctorId: nurse.userId }))).rejects.toThrow(/treating doctor/);
    await expect(issueToVisit(db, nurse, issue({ kitId }))).rejects.toBeInstanceOf(InventoryError);
    await expect(issueToVisit(db, store, issue())).rejects.toBeInstanceOf(ForbiddenError);
    await db.update(visits).set({ status: "closed" }).where(eq(visits.id, visitId));
    await expect(issueToVisit(db, nurse, issue())).rejects.toBeInstanceOf(VisitNotOpenError);
    expect(await balance(s, "G")).toBe(3);
  });
});
