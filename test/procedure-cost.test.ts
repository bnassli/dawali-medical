import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db/client";
import { todayIn } from "@/lib/age";
import { consumptionReport, consumptionWorkbook, WITHOUT_KIT } from "@/modules/inventory/consumption-report";
import { issueToVisit, saveKit } from "@/modules/inventory/kits";
import { consumeForVisit, listWarehouses, receiveStock, stockLevels } from "@/modules/inventory/service";
import { createPatient } from "@/modules/patients/service";
import type { ActorContext } from "@/modules/permissions/types";
import { createVisit } from "@/modules/visits/service";
import { createTestUser, openTestDb, uniqueSuffix } from "./helpers";

const TZ = "Asia/Riyadh";

/** I6 (ADR-044): what one procedure costs in materials. */
describe("Cost per procedure I6 (ADR-044)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let store: ActorContext;
  let nurse: ActorContext;
  let doctorA: ActorContext;
  let doctorB: ActorContext;
  let ops: string;

  beforeAll(async () => {
    ({ db, close } = openTestDb());
    store = (await createTestUser(db, { roleCode: "INVENTORY" })).actor;
    nurse = (await createTestUser(db, { roleCode: "NURSE_ASSISTANT" })).actor;
    doctorA = (await createTestUser(db, { roleCode: "DOCTOR" })).actor;
    doctorB = (await createTestUser(db, { roleCode: "DOCTOR" })).actor;
    ops = (await listWarehouses(db, store)).find((w) => w.code === "operations")!.id;
  });
  afterAll(async () => close());

  async function openVisit() {
    const p = await createPatient(db, doctorA, {
      firstName: `Proc${uniqueSuffix()}`,
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

  it("groups the visits by kit: average, lowest, highest and by doctor; extra items count toward the procedure", async () => {
    const s = uniqueSuffix();
    const today = todayIn(TZ);
    // Fibre 100 per piece, gel 5 per tube, gauze without a price.
    await receiveStock(db, store, {
      receiptId: randomUUID(),
      scanId: null,
      warehouseId: ops,
      supplierName: `Proc supplier ${s}`,
      invoiceNumber: `P-${s}`,
      invoiceDate: today,
      lines: [
        { productName: `Fibre ${s}`, unit: "piece", lotNumber: "F", expiryDate: "2030-01-01", quantity: 10, packSize: 1, unitCost: 100 },
        { productName: `Gel ${s}`, unit: "tube", lotNumber: "G", expiryDate: "2030-01-01", quantity: 10, packSize: 1, unitCost: 5 },
        { productName: `Gauze ${s}`, unit: "pack", lotNumber: "", expiryDate: null, quantity: 10, packSize: 1, unitCost: null },
      ],
    });
    const rows = (await stockLevels(db, store, ops)).filter((r) => r.productName.endsWith(s));
    const product = (n: string) => rows.find((r) => r.productName === `${n} ${s}`)!;
    const kitId = randomUUID();
    const kitName = `EVLT ${s}`;
    await saveKit(db, store, { id: kitId, expectedUpdatedAt: null, name: kitName, isActive: true, items: [{ productId: product("Fibre").productId, quantity: 1 }, { productId: product("Gel").productId, quantity: 1 }] });

    const kit = (visitId: string, doctorId: string, gel = 1) =>
      issueToVisit(db, nurse, { clientMutationId: randomUUID(), visitId, warehouseId: ops, doctorId, kitId, items: [{ productId: product("Fibre").productId, quantity: 1 }, { productId: product("Gel").productId, quantity: gel }] });
    const v1 = await openVisit();
    await kit(v1, doctorA.userId); // 105
    const v2 = await openVisit();
    await kit(v2, doctorA.userId, 3); // 115
    // An extra gauze on top of the kit: in the procedure, without a price.
    await consumeForVisit(db, nurse, { clientMutationId: randomUUID(), visitId: v2, warehouseId: ops, batchId: product("Gauze").batchId, doctorId: doctorA.userId, quantity: 1 });
    const v3 = await openVisit();
    await kit(v3, doctorB.userId); // 105
    const v4 = await openVisit();
    await consumeForVisit(db, nurse, { clientMutationId: randomUUID(), visitId: v4, warehouseId: ops, batchId: product("Gel").batchId, doctorId: doctorB.userId, quantity: 2 }); // 10

    const report = await consumptionReport(db, store, { from: today, to: today }, TZ);
    const evlt = report.byProcedure.find((p) => p.procedure === kitName)!;
    expect(evlt).toMatchObject({ visits: 3, cost: 325, average: 108.33, min: 105, max: 115, incomplete: 1 });
    // Doctor A: 105 + 115; doctor B: 105.
    expect(evlt.byDoctor.map((d) => [d.visits, d.cost, d.average]).sort()).toEqual([[1, 105, 105], [2, 220, 110]]);
    // Visits without a kit are their own group, listed after the kits.
    const mine = report.byVisit.filter((v) => [v1, v2, v3, v4].includes(v.visitId));
    expect(mine).toHaveLength(4);
    expect(mine.find((v) => v.visitId === v2)).toMatchObject({ procedure: kitName, items: 3, cost: 115, unpriced: 1 });
    expect(mine.find((v) => v.visitId === v4)).toMatchObject({ procedure: WITHOUT_KIT, items: 1, cost: 10 });
    expect(report.byProcedure.at(-1)?.procedure).toBe(WITHOUT_KIT);

    const { bytes } = await consumptionWorkbook(db, store, { from: today, to: today }, TZ);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["By doctor", "By product", "By procedure", "By visit", "Details"]);
    const sheet = wb.getWorksheet("By procedure")!;
    const evltRow = sheet.getRows(2, sheet.rowCount - 1)!.find((r) => r.getCell(1).value === kitName && r.getCell(2).value === "All doctors")!;
    expect([evltRow.getCell(3).value, evltRow.getCell(4).value, evltRow.getCell(5).value]).toEqual([3, 325, 108.33]);
  });
});
