import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLogs, visits } from "@/db/schema";
import { LocalFileStorage } from "@/lib/file-storage";
import { VisitNotOpenError } from "@/modules/clinical/service";
import { AnthropicInvoiceExtractor, parseExtraction, type InvoiceExtractor } from "@/modules/inventory/extractor";
import {
  adjustStock,
  consumeForVisit,
  consumptionBetween,
  InsufficientStockError,
  InventoryError,
  listWarehouses,
  receiveStock,
  scanInvoice,
  stockLevels,
  transferStock,
  visitConsumption,
} from "@/modules/inventory/service";
import { createPatient } from "@/modules/patients/service";
import { ForbiddenError } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import { createVisit } from "@/modules/visits/service";
import { createTestUser, openTestDb, uniqueSuffix } from "./helpers";

describe("Inventory I1 (ADR-035)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let store: ActorContext;
  let doctor: ActorContext;
  let nurse: ActorContext;
  let ops: string;
  let clinic: string;
  let dir: string;
  let storage: LocalFileStorage;

  beforeAll(async () => {
    ({ db, close } = openTestDb());
    store = (await createTestUser(db, { roleCode: "INVENTORY" })).actor;
    doctor = (await createTestUser(db, { roleCode: "DOCTOR" })).actor;
    nurse = (await createTestUser(db, { roleCode: "NURSE_ASSISTANT" })).actor;
    const w = await listWarehouses(db, store);
    ops = w.find((x) => x.code === "operations")!.id;
    clinic = w.find((x) => x.code === "clinic")!.id;
    dir = mkdtempSync(path.join(os.tmpdir(), "dawali-inv-"));
    storage = new LocalFileStorage(dir);
  });
  afterAll(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  const receipt = (s: string, lines: { productName: string; quantity: number; lotNumber?: string; expiryDate?: string | null }[]) => ({
    receiptId: randomUUID(),
    scanId: null,
    warehouseId: ops,
    supplierName: `Supplier ${s}`,
    invoiceNumber: `INV-${s}`,
    invoiceDate: "2026-09-20",
    lines: lines.map((l) => ({ unit: "vial", unitCost: 12.5, packSize: 1, lotNumber: l.lotNumber ?? "L1", expiryDate: l.expiryDate ?? "2027-01-31", ...l })),
  });
  const level = async (product: string, wh = ops) =>
    (await stockLevels(db, store, wh)).filter((r) => r.productName === product).reduce((n, r) => n + r.quantity, 0);
  async function openVisit() {
    const s = uniqueSuffix();
    const p = await createPatient(db, doctor, {
      firstName: `Inv${s}`,
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

  it("seeds the Operations store first, then the Clinic store", async () => {
    expect((await listWarehouses(db, store)).map((w) => w.code).slice(0, 2)).toEqual(["operations", "clinic"]);
  });

  it("scans an invoice: stored privately, AI reading returned as a draft, nothing received yet", async () => {
    const fake: InvoiceExtractor = {
      extract: async () => ({
        documentType: "invoice" as const,
        supplierName: "Pharma Co",
        invoiceNumber: "A-1",
        invoiceDate: "2026-09-20",
        lines: [{ productName: "Polidocanol 1%", lotNumber: "P9", expiryDate: "2027-05-31", quantity: 10, packSize: 5, unit: "box of 5", unitCost: 30 }],
      }),
    };
    const r = await scanInvoice(db, storage, fake, store, { bytes: new Uint8Array([1, 2, 3]), fileName: "inv.jpg", contentType: "image/jpeg" });
    expect(r.extracted?.lines[0]?.productName).toBe("Polidocanol 1%");
    expect(await level("Polidocanol 1%")).toBe(0);
    const failed = await scanInvoice(db, storage, null, store, { bytes: new Uint8Array([1]), fileName: "x.pdf", contentType: "application/pdf" });
    expect(failed.error).toMatch(/not configured/);
    await expect(scanInvoice(db, storage, fake, store, { bytes: new Uint8Array([1]), fileName: "x.exe", contentType: "application/x-msdownload" })).rejects.toBeInstanceOf(InventoryError);
    await expect(scanInvoice(db, storage, fake, nurse, { bytes: new Uint8Array([1]), fileName: "a.jpg", contentType: "image/jpeg" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("parses the AI answer defensively and calls the API with the image", async () => {
    expect(parseExtraction('{"documentType":"statement","lines":[]}').documentType).toBe("statement");
    expect(parseExtraction('Here:\n```json\n{"supplierName":"X","invoiceNumber":null,"invoiceDate":"20/09/2026","lines":[{"productName":"Gauze","quantity":"1,200","unitCost":null}]}\n```').lines[0]).toMatchObject({
      productName: "Gauze",
      quantity: 1200,
      lotNumber: null,
    });
    let sent: unknown = null;
    const ex = new AnthropicInvoiceExtractor("key", "claude-sonnet-5", (async (_u: unknown, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ content: [{ type: "text", text: '{"lines":[]}' }] }), { status: 200 });
    }) as typeof fetch);
    await ex.extract({ bytes: new Uint8Array([9]), contentType: "application/pdf" });
    expect(JSON.stringify(sent)).toContain('"type":"document"');
  });

  it("counts stock in units: 10 boxes of 5 = 50; a statement of account is never received", async () => {
    const s = uniqueSuffix();
    const product = `Beauty Supplies P 0.25 ${s}`;
    const input = receipt(s, [{ productName: product, quantity: 10 }]);
    input.lines[0]!.packSize = 5;
    await receiveStock(db, store, input);
    expect(await level(product)).toBe(50);

    const statement: InvoiceExtractor = {
      extract: async () => ({ documentType: "statement", supplierName: "X", invoiceNumber: null, invoiceDate: null, lines: [] }),
    };
    const scan = await scanInvoice(db, storage, statement, store, { bytes: new Uint8Array([7]), fileName: "st.pdf", contentType: "application/pdf" });
    await expect(receiveStock(db, store, { ...receipt(`${s}b`, [{ productName: product, quantity: 1 }]), scanId: scan.scanId })).rejects.toThrow(
      /not an invoice/,
    );
  });

  it("receives a reviewed invoice once; balances are sums of movements; duplicates refused", async () => {
    const s = uniqueSuffix();
    const product = `Stockings ${s}`;
    const input = receipt(s, [
      { productName: product, quantity: 5, lotNumber: "A", expiryDate: "2027-01-01" },
      { productName: product, quantity: 3, lotNumber: "B", expiryDate: "2026-12-01" },
    ]);
    await expect(receiveStock(db, store, input)).resolves.toMatchObject({ replayed: false });
    await expect(receiveStock(db, store, input)).resolves.toMatchObject({ replayed: true });
    await expect(receiveStock(db, store, { ...input, receiptId: randomUUID() })).rejects.toThrow(/already received/);
    expect(await level(product)).toBe(8);
    // FEFO: the batch expiring first comes first.
    expect((await stockLevels(db, store, ops)).filter((r) => r.productName === product).map((r) => r.lotNumber)).toEqual(["B", "A"]);
  });

  it("nurse records materials on the patient AND the doctor; stock goes down, never below zero", async () => {
    const s = uniqueSuffix();
    const product = `Polidocanol ${s}`;
    await receiveStock(db, store, receipt(s, [{ productName: product, quantity: 4 }]));
    const batch = (await stockLevels(db, store, ops)).find((r) => r.productName === product)!;
    const visitId = await openVisit();
    const use = (q: number, id = randomUUID()) =>
      consumeForVisit(db, nurse, { clientMutationId: id, visitId, warehouseId: ops, batchId: batch.batchId, doctorId: doctor.userId, quantity: q });
    const id = randomUUID();
    await use(1.5, id);
    await expect(use(1.5, id)).resolves.toMatchObject({ replayed: true });
    expect(await level(product)).toBe(2.5);
    await expect(use(3)).rejects.toBeInstanceOf(InsufficientStockError);
    await expect(
      consumeForVisit(db, nurse, { clientMutationId: randomUUID(), visitId, warehouseId: ops, batchId: batch.batchId, doctorId: nurse.userId, quantity: 1 }),
    ).rejects.toThrow(/treating doctor/);

    const rows = await visitConsumption(db, nurse, visitId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ productName: product, quantity: 1.5 });
    expect(rows[0]?.doctorName).toBeTruthy();
    const period = await consumptionBetween(db, store, new Date(Date.now() - 60_000), new Date(Date.now() + 60_000));
    expect(period.some((r) => r.productName === product)).toBe(true);
    expect((await db.select().from(auditLogs).where(eq(auditLogs.visitId, visitId))).map((a) => a.action)).toContain("stock.consume");

    await db.update(visits).set({ status: "closed" }).where(eq(visits.id, visitId));
    await expect(use(0.5)).rejects.toBeInstanceOf(VisitNotOpenError);
  });

  it("opening balance, transfer between stores, and the ledger is append-only", async () => {
    const s = uniqueSuffix();
    const product = `Fiber ${s}`;
    await adjustStock(db, store, {
      clientMutationId: randomUUID(),
      warehouseId: ops,
      productName: product,
      unit: "piece",
      lotNumber: "F1",
      expiryDate: null,
      quantity: 6,
      reason: "Opening balance",
    });
    const batch = (await stockLevels(db, store, ops)).find((r) => r.productName === product)!;
    await transferStock(db, store, { clientMutationId: randomUUID(), fromWarehouseId: ops, toWarehouseId: clinic, batchId: batch.batchId, quantity: 2 });
    expect([await level(product, ops), await level(product, clinic)]).toEqual([4, 2]);
    await expect(
      transferStock(db, store, { clientMutationId: randomUUID(), fromWarehouseId: clinic, toWarehouseId: ops, batchId: batch.batchId, quantity: 3 }),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    await expect(
      adjustStock(db, store, { clientMutationId: randomUUID(), warehouseId: ops, productName: product, unit: "piece", lotNumber: "F1", expiryDate: null, quantity: -5, reason: "count" }),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    await expect(transferStock(db, nurse, { clientMutationId: randomUUID(), fromWarehouseId: ops, toWarehouseId: clinic, batchId: batch.batchId, quantity: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    const err = await db.execute(sql`UPDATE stock_movements SET quantity = 100 WHERE batch_id = ${batch.batchId}`).then(() => null, (e: unknown) => e);
    expect(err instanceof Error ? String(err.cause ?? err) : "").toMatch(/append-only/);
  });

  it("the storekeeper sees no patient data; reception has no inventory", async () => {
    const reception = (await createTestUser(db, { roleCode: "RECEPTION" })).actor;
    await expect(stockLevels(db, reception)).rejects.toBeInstanceOf(ForbiddenError);
    expect(store.permissions.has("patient.read")).toBe(false);
  });
});
