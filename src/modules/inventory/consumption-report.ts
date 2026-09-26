import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import ExcelJS from "exceljs";
import type { Database } from "@/db/client";
import { inventoryBatches, inventoryProducts, patients, stockMovements, users, warehouses } from "@/db/schema";
import { writeAudit } from "@/modules/audit/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { requirePermission } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";

/**
 * I2 consumption reports (ADR-037): materials used by doctor, product and patient over a
 * period, with cost from the purchase invoices, and an Excel export. Read-only over the
 * I1 ledger; patient names only for users who may read patients.
 */

export interface ConsumptionFilter {
  /** Inclusive first day and last day, YYYY-MM-DD in the clinic time zone. */
  from: string;
  to: string;
  doctorId?: string;
  warehouseId?: string;
}

export interface ConsumptionLine {
  id: string;
  createdAt: Date;
  doctorId: string | null;
  doctorName: string;
  productId: string;
  productName: string;
  unit: string;
  lotNumber: string;
  warehouseName: string;
  quantity: number;
  /** Cost of one unit (invoice pack price / pack size, before VAT); null when not invoiced with a price. */
  unitCost: number | null;
  lineCost: number | null;
  /** Null when the viewer may not read patients. */
  patientName: string | null;
  recordedBy: string;
}

export interface ConsumptionTotal {
  key: string;
  label: string;
  quantity: number;
  unit: string;
  cost: number;
  /** Lines without a known price (cost excludes them). */
  unpriced: number;
}

export interface ConsumptionReport {
  filter: ConsumptionFilter;
  lines: ConsumptionLine[];
  byDoctor: { doctor: string; cost: number; unpriced: number; products: ConsumptionTotal[] }[];
  byProduct: ConsumptionTotal[];
  totalCost: number;
  unpriced: number;
  canSeePatients: boolean;
}

export class ConsumptionFilterError extends Error {}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** UTC instant of 00:00 on `day` in `timeZone`. */
export function startOfDayIn(day: string, timeZone: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(guess))
      .map((p) => [p.type, p.value]),
  );
  const asZoned = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return new Date(guess - (asZoned - guess));
}

function nextDay(day: string): string {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

function validDay(day: string): boolean {
  return ISO_DAY.test(day) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}

export function checkFilter(f: ConsumptionFilter): void {
  if (!validDay(f.from) || !validDay(f.to)) throw new ConsumptionFilterError("Choose valid From and To dates.");
  if (f.from > f.to) throw new ConsumptionFilterError("From must be on or before To.");
  const days = (Date.parse(f.to) - Date.parse(f.from)) / 86_400_000;
  if (days > 366) throw new ConsumptionFilterError("Choose a period of one year or less.");
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function consumptionReport(
  db: Database,
  actor: ActorContext,
  filter: ConsumptionFilter,
  timeZone: string,
): Promise<ConsumptionReport> {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_MANAGE, { entityType: "stock_movement" });
  checkFilter(filter);
  const canSeePatients = actor.permissions.has(PERMISSIONS.PATIENT_READ);
  const conditions: SQL[] = [
    eq(stockMovements.movementType, "consumption"),
    gte(stockMovements.createdAt, startOfDayIn(filter.from, timeZone)),
    lt(stockMovements.createdAt, startOfDayIn(nextDay(filter.to), timeZone)),
  ];
  if (filter.doctorId) conditions.push(eq(stockMovements.doctorId, filter.doctorId));
  if (filter.warehouseId) conditions.push(eq(stockMovements.warehouseId, filter.warehouseId));

  const doctorName = sql<string | null>`(SELECT display_name FROM users d WHERE d.id = ${stockMovements.doctorId})`;
  // Unit cost of the batch from its priced invoice lines (weighted by units received).
  const unitCost = sql<string | null>`(
    SELECT sum(l.unit_cost * l.quantity) / nullif(sum(l.quantity * l.pack_size), 0)
    FROM purchase_receipt_lines l
    WHERE l.batch_id = ${stockMovements.batchId} AND l.unit_cost IS NOT NULL)`;
  const rows = await db
    .select({
      id: stockMovements.id,
      createdAt: stockMovements.createdAt,
      doctorId: stockMovements.doctorId,
      doctorName,
      productId: inventoryProducts.id,
      productName: inventoryProducts.name,
      unit: inventoryProducts.unit,
      lotNumber: inventoryBatches.lotNumber,
      warehouseName: warehouses.name,
      quantity: stockMovements.quantity,
      unitCost,
      firstName: patients.firstName,
      lastName: patients.lastName,
      recordedBy: users.displayName,
    })
    .from(stockMovements)
    .innerJoin(inventoryBatches, eq(inventoryBatches.id, stockMovements.batchId))
    .innerJoin(inventoryProducts, eq(inventoryProducts.id, inventoryBatches.productId))
    .innerJoin(warehouses, eq(warehouses.id, stockMovements.warehouseId))
    .innerJoin(patients, eq(patients.id, stockMovements.patientId))
    .leftJoin(users, eq(users.id, stockMovements.createdBy))
    .where(and(...conditions))
    .orderBy(desc(stockMovements.createdAt));

  const lines: ConsumptionLine[] = rows.map((r) => {
    const quantity = -Number(r.quantity);
    const cost = r.unitCost === null ? null : Number(r.unitCost);
    return {
      id: r.id,
      createdAt: r.createdAt,
      doctorId: r.doctorId,
      doctorName: r.doctorName ?? "—",
      productId: r.productId,
      productName: r.productName,
      unit: r.unit,
      lotNumber: r.lotNumber,
      warehouseName: r.warehouseName,
      quantity,
      unitCost: cost === null ? null : round2(cost),
      lineCost: cost === null ? null : round2(cost * quantity),
      patientName: canSeePatients ? `${r.firstName} ${r.lastName}`.trim() : null,
      recordedBy: r.recordedBy ?? "—",
    };
  });

  const total = (group: ConsumptionLine[], key: string, label: string): ConsumptionTotal => ({
    key,
    label,
    unit: group[0]?.unit ?? "",
    quantity: round2(group.reduce((s, l) => s + l.quantity, 0)),
    cost: round2(group.reduce((s, l) => s + (l.lineCost ?? 0), 0)),
    unpriced: group.filter((l) => l.lineCost === null).length,
  });
  const groupBy = <K extends string>(items: ConsumptionLine[], key: (l: ConsumptionLine) => K) => {
    const m = new Map<K, ConsumptionLine[]>();
    for (const l of items) m.set(key(l), [...(m.get(key(l)) ?? []), l]);
    return m;
  };
  const productTotals = (items: ConsumptionLine[]) =>
    [...groupBy(items, (l) => l.productId).entries()]
      .map(([id, g]) => total(g, id, g[0]?.productName ?? ""))
      .sort((a, b) => a.label.localeCompare(b.label));

  const byDoctor = [...groupBy(lines, (l) => l.doctorName).entries()]
    .map(([doctor, g]) => {
      const t = total(g, doctor, doctor);
      return { doctor, cost: t.cost, unpriced: t.unpriced, products: productTotals(g) };
    })
    .sort((a, b) => a.doctor.localeCompare(b.doctor));
  const all = total(lines, "all", "all");
  return { filter, lines, byDoctor, byProduct: productTotals(lines), totalCost: all.cost, unpriced: all.unpriced, canSeePatients };
}

function dayOf(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

/** Excel workbook of the report: Summary by doctor, By product, Details. The export is audited. */
export async function consumptionWorkbook(
  db: Database,
  actor: ActorContext,
  filter: ConsumptionFilter,
  timeZone: string,
): Promise<{ bytes: Buffer; fileName: string }> {
  const report = await consumptionReport(db, actor, filter, timeZone);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Dawali Medical";
  const money = "#,##0.00";
  const header = (ws: ExcelJS.Worksheet) => {
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
  };

  const summary = wb.addWorksheet("By doctor");
  summary.columns = [
    { header: "Doctor", key: "doctor", width: 28 },
    { header: "Product", key: "product", width: 40 },
    { header: "Quantity", key: "quantity", width: 12 },
    { header: "Unit", key: "unit", width: 10 },
    { header: "Cost (SAR, excl. VAT)", key: "cost", width: 20, style: { numFmt: money } },
    { header: "Lines without price", key: "unpriced", width: 18 },
  ];
  for (const d of report.byDoctor) {
    for (const p of d.products) {
      summary.addRow({ doctor: d.doctor, product: p.label, quantity: p.quantity, unit: p.unit, cost: p.cost, unpriced: p.unpriced || null });
    }
    summary.addRow({ doctor: `${d.doctor} — total`, cost: d.cost, unpriced: d.unpriced || null }).font = { bold: true };
  }
  summary.addRow({ doctor: "Grand total", cost: report.totalCost, unpriced: report.unpriced || null }).font = { bold: true };
  header(summary);

  const products = wb.addWorksheet("By product");
  products.columns = [
    { header: "Product", key: "product", width: 40 },
    { header: "Quantity", key: "quantity", width: 12 },
    { header: "Unit", key: "unit", width: 10 },
    { header: "Cost (SAR, excl. VAT)", key: "cost", width: 20, style: { numFmt: money } },
    { header: "Lines without price", key: "unpriced", width: 18 },
  ];
  for (const p of report.byProduct) {
    products.addRow({ product: p.label, quantity: p.quantity, unit: p.unit, cost: p.cost, unpriced: p.unpriced || null });
  }
  header(products);

  const details = wb.addWorksheet("Details");
  details.columns = [
    { header: "Date", key: "date", width: 12 },
    ...(report.canSeePatients
      ? [{ header: "Patient", key: "patient", width: 28 }]
      : []),
    { header: "Doctor", key: "doctor", width: 24 },
    { header: "Product", key: "product", width: 36 },
    { header: "Lot", key: "lot", width: 14 },
    { header: "Store", key: "store", width: 16 },
    { header: "Quantity", key: "quantity", width: 10 },
    { header: "Unit", key: "unit", width: 8 },
    { header: "Unit cost", key: "unitCost", width: 12, style: { numFmt: money } },
    { header: "Cost", key: "cost", width: 12, style: { numFmt: money } },
    { header: "Recorded by", key: "recordedBy", width: 20 },
  ];
  for (const l of report.lines) {
    details.addRow({
      date: dayOf(l.createdAt, timeZone),
      patient: l.patientName,
      doctor: l.doctorName,
      product: l.productName,
      lot: l.lotNumber || "—",
      store: l.warehouseName,
      quantity: l.quantity,
      unit: l.unit,
      unitCost: l.unitCost,
      cost: l.lineCost,
      recordedBy: l.recordedBy,
    });
  }
  header(details);

  const bytes = Buffer.from(await wb.xlsx.writeBuffer());
  await writeAudit(db, {
    actorUserId: actor.userId,
    action: "consumption_report.export",
    entityType: "consumption_report",
    entityId: randomUUID(),
    after: { ...filter, lines: report.lines.length, includesPatients: report.canSeePatients },
    metadata: { ip: actor.ip ?? null, userAgent: actor.userAgent ?? null },
  });
  return { bytes, fileName: `materials-used_${filter.from}_${filter.to}.xlsx` };
}
