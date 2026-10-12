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
  visitId: string | null;
  /** I4: the procedure kit the line was recorded with, if any. */
  kitName: string | null;
}

/** I6 (ADR-044): the materials of one visit — one procedure — and their cost. */
export interface VisitCost {
  visitId: string;
  /** First material recorded on the visit in the period. */
  date: Date;
  patientName: string | null;
  doctors: string;
  /** The kits used ("EVLT", "EVLT + Sclerotherapy") or WITHOUT_KIT. */
  procedure: string;
  items: number;
  cost: number;
  unpriced: number;
}

/** Cost per procedure type: what one procedure costs in materials, on average and by doctor. */
export interface ProcedureCost {
  procedure: string;
  visits: number;
  cost: number;
  average: number;
  min: number;
  max: number;
  /** Visits with at least one line without an invoice price (their cost is too low). */
  incomplete: number;
  byDoctor: { doctor: string; visits: number; cost: number; average: number }[];
}

/** Label of visits whose materials were all recorded item by item. */
export const WITHOUT_KIT = "Without a kit";

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
  byVisit: VisitCost[];
  byProcedure: ProcedureCost[];
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
      visitId: stockMovements.visitId,
      kitName: sql<string | null>`(SELECT k.name FROM procedure_kits k WHERE k.id = ${stockMovements.kitId})`,
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
      visitId: r.visitId,
      kitName: r.kitName,
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
  const byVisit = visitCosts(lines);
  return {
    filter,
    lines,
    byDoctor,
    byProduct: productTotals(lines),
    byVisit,
    byProcedure: procedureCosts(byVisit),
    totalCost: all.cost,
    unpriced: all.unpriced,
    canSeePatients,
  };
}

/** One row per visit (= one procedure): all its materials in the period, newest first. */
export function visitCosts(lines: ConsumptionLine[]): VisitCost[] {
  const visits = new Map<string, ConsumptionLine[]>();
  for (const l of lines) if (l.visitId) visits.set(l.visitId, [...(visits.get(l.visitId) ?? []), l]);
  const distinct = (xs: string[]) => [...new Set(xs)].sort((a, b) => a.localeCompare(b));
  return [...visits.entries()]
    .map(([visitId, g]) => {
      const kits = distinct(g.flatMap((l) => (l.kitName ? [l.kitName] : [])));
      return {
        visitId,
        date: new Date(Math.min(...g.map((l) => l.createdAt.getTime()))),
        patientName: g[0]!.patientName,
        doctors: distinct(g.map((l) => l.doctorName)).join(", "),
        procedure: kits.length > 0 ? kits.join(" + ") : WITHOUT_KIT,
        items: g.length,
        cost: round2(g.reduce((n, l) => n + (l.lineCost ?? 0), 0)),
        unpriced: g.filter((l) => l.lineCost === null).length,
      };
    })
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}

/** Per procedure type (kit), most frequent first; "Without a kit" last. */
export function procedureCosts(visits: VisitCost[]): ProcedureCost[] {
  const groups = new Map<string, VisitCost[]>();
  for (const v of visits) groups.set(v.procedure, [...(groups.get(v.procedure) ?? []), v]);
  const sum = (vs: VisitCost[]) => round2(vs.reduce((n, v) => n + v.cost, 0));
  return [...groups.entries()]
    .map(([procedure, vs]) => {
      const doctors = new Map<string, VisitCost[]>();
      for (const v of vs) doctors.set(v.doctors, [...(doctors.get(v.doctors) ?? []), v]);
      return {
        procedure,
        visits: vs.length,
        cost: sum(vs),
        average: round2(sum(vs) / vs.length),
        min: Math.min(...vs.map((v) => v.cost)),
        max: Math.max(...vs.map((v) => v.cost)),
        incomplete: vs.filter((v) => v.unpriced > 0).length,
        byDoctor: [...doctors.entries()]
          .map(([doctor, dv]) => ({ doctor, visits: dv.length, cost: sum(dv), average: round2(sum(dv) / dv.length) }))
          .sort((a, b) => a.doctor.localeCompare(b.doctor)),
      };
    })
    .sort((a, b) => (a.procedure === WITHOUT_KIT ? 1 : b.procedure === WITHOUT_KIT ? -1 : b.visits - a.visits || a.procedure.localeCompare(b.procedure)));
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

  const procedures = wb.addWorksheet("By procedure");
  procedures.columns = [
    { header: "Procedure (kit)", key: "procedure", width: 30 },
    { header: "Doctor", key: "doctor", width: 26 },
    { header: "Procedures", key: "visits", width: 12 },
    { header: "Total cost (SAR, excl. VAT)", key: "cost", width: 24, style: { numFmt: money } },
    { header: "Average per procedure", key: "average", width: 22, style: { numFmt: money } },
    { header: "Lowest", key: "min", width: 12, style: { numFmt: money } },
    { header: "Highest", key: "max", width: 12, style: { numFmt: money } },
    { header: "With unpriced lines", key: "incomplete", width: 18 },
  ];
  for (const p of report.byProcedure) {
    procedures.addRow({ procedure: p.procedure, doctor: "All doctors", visits: p.visits, cost: p.cost, average: p.average, min: p.min, max: p.max, incomplete: p.incomplete || null }).font = { bold: true };
    for (const d of p.byDoctor) procedures.addRow({ procedure: p.procedure, doctor: d.doctor, visits: d.visits, cost: d.cost, average: d.average });
  }
  header(procedures);

  const visits = wb.addWorksheet("By visit");
  visits.columns = [
    { header: "Date", key: "date", width: 12 },
    ...(report.canSeePatients ? [{ header: "Patient", key: "patient", width: 28 }] : []),
    { header: "Doctor", key: "doctor", width: 24 },
    { header: "Procedure (kit)", key: "procedure", width: 28 },
    { header: "Lines", key: "items", width: 8 },
    { header: "Cost (SAR, excl. VAT)", key: "cost", width: 20, style: { numFmt: money } },
    { header: "Lines without price", key: "unpriced", width: 18 },
  ];
  for (const v of report.byVisit) {
    visits.addRow({ date: dayOf(v.date, timeZone), patient: v.patientName, doctor: v.doctors, procedure: v.procedure, items: v.items, cost: v.cost, unpriced: v.unpriced || null });
  }
  header(visits);

  const details = wb.addWorksheet("Details");
  details.columns = [
    { header: "Date", key: "date", width: 12 },
    ...(report.canSeePatients
      ? [{ header: "Patient", key: "patient", width: 28 }]
      : []),
    { header: "Doctor", key: "doctor", width: 24 },
    { header: "Product", key: "product", width: 36 },
    { header: "Kit", key: "kit", width: 18 },
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
      kit: l.kitName,
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
