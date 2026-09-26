import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLogs } from "@/db/schema";
import { consumptionReport, consumptionWorkbook, startOfDayIn } from "@/modules/inventory/consumption-report";
import { consumeForVisit, listWarehouses, receiveStock, stockLevels } from "@/modules/inventory/service";
import { createPatient } from "@/modules/patients/service";
import { ForbiddenError } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import { createVisit } from "@/modules/visits/service";
import { createTestUser, openTestDb, uniqueSuffix } from "./helpers";

const TZ = "Asia/Riyadh";

describe("Consumption reports I2 (ADR-037)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let store: ActorContext;
  let admin: ActorContext;
  let doctorA: ActorContext;
  let doctorB: ActorContext;
  let nurse: ActorContext;
  let ops: string;

  beforeAll(async () => {
    ({ db, close } = openTestDb());
    store = (await createTestUser(db, { roleCode: "INVENTORY" })).actor;
    admin = (await createTestUser(db, { roleCode: "ADMIN" })).actor;
    doctorA = (await createTestUser(db, { roleCode: "DOCTOR" })).actor;
    doctorB = (await createTestUser(db, { roleCode: "DOCTOR" })).actor;
    nurse = (await createTestUser(db, { roleCode: "NURSE_ASSISTANT" })).actor;
    ops = (await listWarehouses(db, store)).find((w) => w.code === "operations")!.id;
  });
  afterAll(async () => close());

  const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

  async function openVisit(s: string) {
    const p = await createPatient(db, doctorA, {
      firstName: `Rep${s}`,
      lastName: "Patient",
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });
    return (await createVisit(db, doctorA, { patientId: p.id, reason: undefined })).id;
  }

  it("clinic-day boundaries follow the clinic time zone", () => {
    expect(startOfDayIn("2026-09-26", TZ).toISOString()).toBe("2026-09-25T21:00:00.000Z");
    expect(startOfDayIn("2026-09-26", "UTC").toISOString()).toBe("2026-09-26T00:00:00.000Z");
  });

  it("totals by doctor and product with cost per unit from the invoice; patient names only with patient access", async () => {
    const s = uniqueSuffix();
    const priced = `Sclero ${s}`;
    const unpriced = `Gauze ${s}`;
    // 2 boxes of 5 at 50 SAR/box => 10 SAR per unit.
    await receiveStock(db, store, {
      receiptId: randomUUID(),
      scanId: null,
      warehouseId: ops,
      supplierName: `Supplier ${s}`,
      invoiceNumber: `INV-${s}`,
      invoiceDate: "2026-09-20",
      lines: [
        { productName: priced, unit: "vial", quantity: 2, packSize: 5, unitCost: 50, lotNumber: "P1", expiryDate: "2027-06-30" },
        { productName: unpriced, unit: "pack", quantity: 10, packSize: 1, unitCost: null, lotNumber: "G1", expiryDate: null },
      ],
    });
    const batches = (await stockLevels(db, store, ops)).filter((r) => r.productName.endsWith(s));
    const batchOf = (name: string) => batches.find((b) => b.productName === name)!.batchId;
    const visitId = await openVisit(s);
    const use = (name: string, doctorId: string, quantity: number) =>
      consumeForVisit(db, nurse, { clientMutationId: randomUUID(), visitId, warehouseId: ops, batchId: batchOf(name), doctorId, quantity });
    await use(priced, doctorA.userId, 3);
    await use(priced, doctorB.userId, 1.5);
    await use(unpriced, doctorA.userId, 2);

    const filter = { from: today(), to: today() };
    const r = await consumptionReport(db, store, filter, TZ);
    const mine = r.lines.filter((l) => l.productName.endsWith(s));
    expect(mine).toHaveLength(3);
    expect(mine.find((l) => l.quantity === 3)).toMatchObject({ unitCost: 10, lineCost: 30 });
    expect(mine.find((l) => l.productName === unpriced)).toMatchObject({ unitCost: null, lineCost: null });
    // The storekeeper has no patient access: no names.
    expect(r.canSeePatients).toBe(false);
    expect(mine.every((l) => l.patientName === null)).toBe(true);
    expect(r.byProduct.find((p) => p.label === priced)).toMatchObject({ quantity: 4.5, cost: 45, unpriced: 0 });
    expect(r.byProduct.find((p) => p.label === unpriced)).toMatchObject({ quantity: 2, cost: 0, unpriced: 1 });

    // One doctor only.
    const onlyA = await consumptionReport(db, store, { ...filter, doctorId: doctorA.userId }, TZ);
    expect(onlyA.lines.every((l) => l.doctorId === doctorA.userId)).toBe(true);
    expect(onlyA.byDoctor).toHaveLength(1);
    expect(onlyA.byDoctor[0]?.cost).toBe(30);
    expect(onlyA.byDoctor[0]?.unpriced).toBe(1);

    // Admin (patient read) sees the names.
    const withNames = await consumptionReport(db, admin, filter, TZ);
    expect(withNames.lines.find((l) => l.productName === priced)?.patientName).toBe(`Rep${s} Patient`);

    // Outside the period: nothing of ours.
    const past = await consumptionReport(db, store, { from: "2020-01-01", to: "2020-01-31" }, TZ);
    expect(past.lines).toHaveLength(0);
  });

  it("exports an Excel workbook (audited) and refuses bad periods and users without inventory management", async () => {
    const { bytes, fileName } = await consumptionWorkbook(db, store, { from: today(), to: today() }, TZ);
    expect(fileName).toBe(`materials-used_${today()}_${today()}.xlsx`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["By doctor", "By product", "Details"]);
    // No patient column for the storekeeper.
    expect(wb.getWorksheet("Details")!.getRow(1).values).not.toContain("Patient");
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.actorUserId, store.userId));
    expect(audits.map((a) => a.action)).toContain("consumption_report.export");

    await expect(consumptionReport(db, store, { from: "2026-09-10", to: "2026-09-01" }, TZ)).rejects.toThrow(/on or before/);
    await expect(consumptionReport(db, store, { from: "2026-02-31", to: "2026-03-01" }, TZ)).rejects.toThrow(/valid/);
    await expect(consumptionReport(db, store, { from: "2024-01-01", to: "2026-01-01" }, TZ)).rejects.toThrow(/one year/);
    await expect(consumptionReport(db, nurse, { from: today(), to: today() }, TZ)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(consumptionReport(db, doctorA, { from: today(), to: today() }, TZ)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
