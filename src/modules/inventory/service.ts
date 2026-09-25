import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/db/client";
import {
  inventoryBatches,
  inventoryProducts,
  invoiceScans,
  patients,
  purchaseReceiptLines,
  purchaseReceipts,
  roles,
  stockMovements,
  suppliers,
  userRoles,
  users,
  visits,
  warehouses,
  type ExtractedInvoice,
} from "@/db/schema";
import type { FileStorage } from "@/lib/file-storage";
import { writeAudit } from "@/modules/audit/service";
import { isUniqueViolation, VisitNotFoundError, VisitNotOpenError } from "@/modules/clinical/service";
import { PERMISSIONS, ROLES } from "@/modules/permissions/constants";
import { requirePermission } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import type { InvoiceExtractor } from "./extractor";

/**
 * Inventory I1 (ADR-035). The balance of a batch in a store is the SUM of its
 * append-only stock movements; nothing is overwritten and stock can never go
 * below zero (checked under a per-batch lock). Materials used on a patient are
 * recorded by the nurse against the visit's patient AND the treating doctor.
 */

export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryError";
  }
}
export class InsufficientStockError extends InventoryError {
  constructor(available: number, unit: string) {
    super(`Not enough stock: only ${available} ${unit} available in this store.`);
    this.name = "InsufficientStockError";
  }
}

const qty = z
  .number()
  .finite()
  .refine((n) => Math.round(n * 100) === n * 100, "At most 2 decimals.")
  .refine((n) => Math.abs(n) <= 1_000_000, "Quantity is too large.");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date (YYYY-MM-DD).");
const text = (max: number) => z.string().trim().max(max);

const meta = (actor: ActorContext) => ({ ip: actor.ip ?? null, userAgent: actor.userAgent ?? null });

export interface WarehouseView {
  id: string;
  code: string;
  name: string;
}

export async function listWarehouses(db: Database, actor: ActorContext): Promise<WarehouseView[]> {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_READ, { entityType: "warehouse" });
  return db
    .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name })
    .from(warehouses)
    .where(eq(warehouses.isActive, true))
    // Operations store first: it is the one the clinic uses now.
    .orderBy(sql`${warehouses.code} <> 'operations'`, asc(warehouses.name));
}

export async function listProducts(db: Database, actor: ActorContext) {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_READ, { entityType: "inventory_product" });
  return db
    .select({ id: inventoryProducts.id, name: inventoryProducts.name, unit: inventoryProducts.unit, isActive: inventoryProducts.isActive })
    .from(inventoryProducts)
    .orderBy(asc(inventoryProducts.name));
}

export async function listSuppliers(db: Database, actor: ActorContext) {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_READ, { entityType: "supplier" });
  return db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).orderBy(asc(suppliers.name));
}

/** Active users with the Doctor role: the doctor a consumption is charged to. */
export async function listDoctors(db: Database): Promise<{ id: string; name: string }[]> {
  return db
    .selectDistinct({ id: users.id, name: users.displayName })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(roles.code, ROLES.DOCTOR), eq(users.isActive, true)))
    .orderBy(asc(users.displayName));
}

async function findOrCreateProduct(tx: Database, actor: ActorContext, name: string, unit: string): Promise<string> {
  const [found] = await tx
    .select({ id: inventoryProducts.id })
    .from(inventoryProducts)
    .where(sql`lower(${inventoryProducts.name}) = lower(${name})`)
    .limit(1);
  if (found) return found.id;
  const [created] = await tx.insert(inventoryProducts).values({ name, unit, createdBy: actor.userId }).returning();
  if (!created) throw new Error("Failed to create product");
  await writeAudit(tx, { actorUserId: actor.userId, action: "inventory_product.create", entityType: "inventory_product", entityId: created.id, after: created, metadata: meta(actor) });
  return created.id;
}

async function findOrCreateBatch(tx: Database, productId: string, lotNumber: string, expiryDate: string | null): Promise<string> {
  const where = and(
    eq(inventoryBatches.productId, productId),
    eq(inventoryBatches.lotNumber, lotNumber),
    expiryDate === null ? isNull(inventoryBatches.expiryDate) : eq(inventoryBatches.expiryDate, expiryDate),
  );
  const [found] = await tx.select({ id: inventoryBatches.id }).from(inventoryBatches).where(where).limit(1);
  if (found) return found.id;
  const [created] = await tx
    .insert(inventoryBatches)
    .values({ productId, lotNumber, expiryDate })
    .onConflictDoNothing()
    .returning({ id: inventoryBatches.id });
  if (created) return created.id;
  const [raced] = await tx.select({ id: inventoryBatches.id }).from(inventoryBatches).where(where).limit(1);
  if (!raced) throw new Error("Failed to create batch");
  return raced.id;
}

/** Current balance of a batch in a store, after taking the batch's lock. */
async function lockedBalance(tx: Database, warehouseId: string, batchId: string): Promise<number> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`stock:${warehouseId}:${batchId}`}, 0))`);
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${stockMovements.quantity}), 0)` })
    .from(stockMovements)
    .where(and(eq(stockMovements.warehouseId, warehouseId), eq(stockMovements.batchId, batchId)));
  return Number(row?.total ?? 0);
}

async function batchInfo(tx: Database, batchId: string) {
  const [b] = await tx
    .select({ id: inventoryBatches.id, productId: inventoryBatches.productId, unit: inventoryProducts.unit, name: inventoryProducts.name })
    .from(inventoryBatches)
    .innerJoin(inventoryProducts, eq(inventoryProducts.id, inventoryBatches.productId))
    .where(eq(inventoryBatches.id, batchId))
    .limit(1);
  if (!b) throw new InventoryError("Unknown batch.");
  return b;
}

async function alreadyApplied(tx: Database, clientMutationId: string) {
  const [row] = await tx.select().from(stockMovements).where(eq(stockMovements.clientMutationId, clientMutationId)).limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------- scanning

export const MAX_SCAN_BYTES = 10 * 1024 * 1024;
const SCAN_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };

export interface ScanResult {
  scanId: string;
  extracted: ExtractedInvoice | null;
  error: string | null;
}

/**
 * Stores a scanned invoice privately and asks the AI to read it. The result
 * is a draft for review; no stock moves here. Without an extractor (no AI
 * key) or when reading fails, the scan is kept and the form is typed by hand.
 */
export async function scanInvoice(
  db: Database,
  storage: FileStorage,
  extractor: InvoiceExtractor | null,
  actor: ActorContext,
  file: { bytes: Uint8Array; fileName: string; contentType: string },
): Promise<ScanResult> {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_MANAGE, { entityType: "invoice_scan" });
  const ext = SCAN_TYPES[file.contentType];
  if (!ext) throw new InventoryError("Scan the invoice as a JPG, PNG, WEBP image or a PDF.");
  if (file.bytes.length === 0 || file.bytes.length > MAX_SCAN_BYTES) throw new InventoryError("The scan must be under 10 MB.");
  const id = randomUUID();
  const storageKey = `inventory/invoices/${id}.${ext}`;
  await storage.put(storageKey, file.bytes);
  let extracted: ExtractedInvoice | null = null;
  let error: string | null = null;
  if (!extractor) error = "AI reading is not configured; enter the invoice by hand.";
  else {
    try {
      extracted = await extractor.extract({ bytes: file.bytes, contentType: file.contentType });
    } catch (err) {
      error = err instanceof Error ? err.message : "AI reading failed.";
    }
  }
  await db.insert(invoiceScans).values({
    id,
    storageKey,
    fileName: file.fileName.slice(0, 200) || `invoice.${ext}`,
    contentType: file.contentType,
    byteSize: file.bytes.length,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
    extracted,
    extractionError: error,
    createdBy: actor.userId,
  });
  await writeAudit(db, {
    actorUserId: actor.userId,
    action: "invoice_scan.create",
    entityType: "invoice_scan",
    entityId: id,
    after: { fileName: file.fileName, lines: extracted?.lines.length ?? 0, error },
    metadata: meta(actor),
  });
  return { scanId: id, extracted, error };
}

// ---------------------------------------------------------------- receiving

export const receiveSchema = z.object({
  receiptId: z.string().uuid(),
  scanId: z.string().uuid().nullable(),
  warehouseId: z.string().uuid(),
  supplierName: text(200).min(1, "Supplier is required."),
  invoiceNumber: text(100).min(1, "Invoice number is required."),
  invoiceDate: isoDate,
  lines: z
    .array(
      z.object({
        productName: text(200).min(1, "Product name is required."),
        unit: text(40).min(1, "Unit is required."),
        lotNumber: text(100),
        expiryDate: isoDate.nullable(),
        quantity: qty.refine((n) => n > 0, "Quantity must be more than 0."),
        packSize: qty.refine((n) => n > 0, "Units per pack must be more than 0."),
        unitCost: qty.nullable(),
      }),
    )
    .min(1, "Add at least one line.")
    .max(200),
});
export type ReceiveInput = z.infer<typeof receiveSchema>;

/**
 * Posts a reviewed purchase invoice: one receipt, its lines and one "+" stock
 * movement per line. Products, suppliers and batches are matched by name
 * (case-insensitive) or created. Idempotent by receiptId.
 */
export async function receiveStock(db: Database, actor: ActorContext, raw: ReceiveInput): Promise<{ receiptId: string; replayed: boolean }> {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_MANAGE, { entityType: "purchase_receipt" });
  const input = receiveSchema.parse(raw);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.receiptId}, 0))`);
    const [existing] = await tx.select().from(purchaseReceipts).where(eq(purchaseReceipts.id, input.receiptId)).limit(1);
    if (existing) {
      if (existing.createdBy !== actor.userId) throw new InventoryError("This receipt id was already used.");
      return { receiptId: existing.id, replayed: true };
    }
    const [wh] = await tx.select().from(warehouses).where(eq(warehouses.id, input.warehouseId)).limit(1);
    if (!wh) throw new InventoryError("Unknown store.");
    if (input.scanId) {
      const [scan] = await tx.select().from(invoiceScans).where(eq(invoiceScans.id, input.scanId)).limit(1);
      if (!scan) throw new InventoryError("Unknown scan.");
      if (scan.extracted && scan.extracted.documentType !== "invoice") {
        throw new InventoryError("The scanned document is not an invoice (e.g. a statement of account); nothing to receive.");
      }
      const [used] = await tx.select({ id: purchaseReceipts.id }).from(purchaseReceipts).where(eq(purchaseReceipts.scanId, input.scanId)).limit(1);
      if (used) throw new InventoryError("This scanned invoice was already received.");
    }
    let [supplier] = await tx.select().from(suppliers).where(sql`lower(${suppliers.name}) = lower(${input.supplierName})`).limit(1);
    if (!supplier) {
      [supplier] = await tx.insert(suppliers).values({ name: input.supplierName, createdBy: actor.userId }).returning();
    }
    const [duplicate] = await tx
      .select({ id: purchaseReceipts.id })
      .from(purchaseReceipts)
      .where(and(eq(purchaseReceipts.supplierId, supplier!.id), sql`lower(${purchaseReceipts.invoiceNumber}) = lower(${input.invoiceNumber})`))
      .limit(1);
    if (duplicate) throw new InventoryError(`Invoice ${input.invoiceNumber} of ${input.supplierName} was already received.`);

    await tx.insert(purchaseReceipts).values({
      id: input.receiptId,
      supplierId: supplier!.id,
      invoiceNumber: input.invoiceNumber,
      invoiceDate: input.invoiceDate,
      warehouseId: wh.id,
      scanId: input.scanId,
      createdBy: actor.userId,
    });
    for (const line of input.lines) {
      const productId = await findOrCreateProduct(tx, actor, line.productName, line.unit);
      const batchId = await findOrCreateBatch(tx, productId, line.lotNumber, line.expiryDate);
      await tx.insert(purchaseReceiptLines).values({
        receiptId: input.receiptId,
        batchId,
        quantity: String(line.quantity),
        packSize: String(line.packSize),
        unitCost: line.unitCost === null ? null : String(line.unitCost),
      });
      // Stock is counted in units: 10 boxes of 5 = 50.
      const units = Math.round(line.quantity * line.packSize * 100) / 100;
      await tx.insert(stockMovements).values({
        warehouseId: wh.id,
        batchId,
        quantity: String(units),
        movementType: "receipt",
        receiptId: input.receiptId,
        clientMutationId: input.receiptId,
        createdBy: actor.userId,
      });
    }
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "purchase_receipt.create",
      entityType: "purchase_receipt",
      entityId: input.receiptId,
      after: input,
      metadata: meta(actor),
    });
    return { receiptId: input.receiptId, replayed: false };
  });
}

// ---------------------------------------------------------------- moving stock

export const adjustSchema = z.object({
  clientMutationId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  productName: text(200).min(1),
  unit: text(40).min(1),
  lotNumber: text(100),
  expiryDate: isoDate.nullable(),
  quantity: qty.refine((n) => n !== 0, "Quantity cannot be 0."),
  reason: text(500).min(3, "Give a reason (e.g. opening balance, stock count)."),
});

/** Opening balance or stock-count correction: one signed movement with a reason. */
export async function adjustStock(db: Database, actor: ActorContext, raw: z.infer<typeof adjustSchema>) {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_MANAGE, { entityType: "stock_movement" });
  const input = adjustSchema.parse(raw);
  return db.transaction(async (tx) => {
    if (await alreadyApplied(tx, input.clientMutationId)) return { replayed: true };
    const productId = await findOrCreateProduct(tx, actor, input.productName, input.unit);
    const batchId = await findOrCreateBatch(tx, productId, input.lotNumber, input.expiryDate);
    const balance = await lockedBalance(tx, input.warehouseId, batchId);
    if (balance + input.quantity < 0) throw new InsufficientStockError(balance, input.unit);
    await tx.insert(stockMovements).values({
      warehouseId: input.warehouseId,
      batchId,
      quantity: String(input.quantity),
      movementType: "adjustment",
      reason: input.reason,
      clientMutationId: input.clientMutationId,
      createdBy: actor.userId,
    });
    await writeAudit(tx, { actorUserId: actor.userId, action: "stock.adjust", entityType: "inventory_batch", entityId: batchId, after: input, metadata: meta(actor) });
    return { replayed: false };
  });
}

export const transferSchema = z.object({
  clientMutationId: z.string().uuid(),
  fromWarehouseId: z.string().uuid(),
  toWarehouseId: z.string().uuid(),
  batchId: z.string().uuid(),
  quantity: qty.refine((n) => n > 0, "Quantity must be more than 0."),
});

export async function transferStock(db: Database, actor: ActorContext, raw: z.infer<typeof transferSchema>) {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_MANAGE, { entityType: "stock_movement" });
  const input = transferSchema.parse(raw);
  if (input.fromWarehouseId === input.toWarehouseId) throw new InventoryError("Choose two different stores.");
  return db.transaction(async (tx) => {
    if (await alreadyApplied(tx, input.clientMutationId)) return { replayed: true };
    const b = await batchInfo(tx, input.batchId);
    const balance = await lockedBalance(tx, input.fromWarehouseId, input.batchId);
    if (balance < input.quantity) throw new InsufficientStockError(balance, b.unit);
    const transferId = randomUUID();
    const common = { batchId: input.batchId, transferId, clientMutationId: input.clientMutationId, createdBy: actor.userId };
    await tx.insert(stockMovements).values([
      { ...common, warehouseId: input.fromWarehouseId, quantity: String(-input.quantity), movementType: "transfer_out" },
      { ...common, warehouseId: input.toWarehouseId, quantity: String(input.quantity), movementType: "transfer_in" },
    ]);
    await writeAudit(tx, { actorUserId: actor.userId, action: "stock.transfer", entityType: "inventory_batch", entityId: input.batchId, after: input, metadata: meta(actor) });
    return { replayed: false };
  });
}

export const consumeSchema = z.object({
  clientMutationId: z.string().uuid(),
  visitId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  batchId: z.string().uuid(),
  doctorId: z.string().uuid(),
  quantity: qty.refine((n) => n > 0, "Quantity must be more than 0."),
});

/**
 * Materials used on a patient: taken from the store's batch, charged to the
 * visit's patient and to the chosen doctor. The visit must be open.
 */
export async function consumeForVisit(db: Database, actor: ActorContext, raw: z.infer<typeof consumeSchema>) {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_CONSUME, { entityType: "stock_movement", visitId: raw.visitId });
  const input = consumeSchema.parse(raw);
  const doctors = await listDoctors(db);
  if (!doctors.some((d) => d.id === input.doctorId)) throw new InventoryError("Choose the treating doctor.");
  try {
    return await db.transaction(async (tx) => {
      if (await alreadyApplied(tx, input.clientMutationId)) return { replayed: true };
      const [visit] = await tx
        .select({ id: visits.id, patientId: visits.patientId, status: visits.status })
        .from(visits)
        .where(eq(visits.id, input.visitId))
        .limit(1);
      if (!visit) throw new VisitNotFoundError(input.visitId);
      if (visit.status !== "open") throw new VisitNotOpenError(visit.id, visit.status);
      const b = await batchInfo(tx, input.batchId);
      const balance = await lockedBalance(tx, input.warehouseId, input.batchId);
      if (balance < input.quantity) throw new InsufficientStockError(balance, b.unit);
      await tx.insert(stockMovements).values({
        warehouseId: input.warehouseId,
        batchId: input.batchId,
        quantity: String(-input.quantity),
        movementType: "consumption",
        visitId: visit.id,
        patientId: visit.patientId,
        doctorId: input.doctorId,
        clientMutationId: input.clientMutationId,
        createdBy: actor.userId,
      });
      await writeAudit(tx, {
        actorUserId: actor.userId,
        action: "stock.consume",
        entityType: "inventory_batch",
        entityId: input.batchId,
        patientId: visit.patientId,
        visitId: visit.id,
        after: { ...input, product: b.name, unit: b.unit },
        metadata: meta(actor),
      });
      return { replayed: false };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { replayed: true };
    throw err;
  }
}

// ---------------------------------------------------------------- reading

export interface StockRow {
  warehouseId: string;
  warehouseName: string;
  batchId: string;
  productName: string;
  unit: string;
  lotNumber: string;
  expiryDate: string | null;
  quantity: number;
}

/** Positive balances per store and batch, earliest expiry first (FEFO). */
export async function stockLevels(db: Database, actor: ActorContext, warehouseId?: string): Promise<StockRow[]> {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_READ, { entityType: "stock_movement" });
  const total = sql<string>`sum(${stockMovements.quantity})`;
  const rows = await db
    .select({
      warehouseId: warehouses.id,
      warehouseName: warehouses.name,
      batchId: inventoryBatches.id,
      productName: inventoryProducts.name,
      unit: inventoryProducts.unit,
      lotNumber: inventoryBatches.lotNumber,
      expiryDate: inventoryBatches.expiryDate,
      quantity: total,
    })
    .from(stockMovements)
    .innerJoin(warehouses, eq(warehouses.id, stockMovements.warehouseId))
    .innerJoin(inventoryBatches, eq(inventoryBatches.id, stockMovements.batchId))
    .innerJoin(inventoryProducts, eq(inventoryProducts.id, inventoryBatches.productId))
    .where(warehouseId ? eq(stockMovements.warehouseId, warehouseId) : undefined)
    .groupBy(warehouses.id, inventoryBatches.id, inventoryProducts.id)
    .having(sql`${total} > 0`)
    .orderBy(asc(inventoryProducts.name), sql`${inventoryBatches.expiryDate} ASC NULLS LAST`);
  return rows.map((r) => ({ ...r, quantity: Number(r.quantity) }));
}

export interface ConsumptionRow {
  id: string;
  createdAt: Date;
  productName: string;
  unit: string;
  lotNumber: string;
  expiryDate: string | null;
  quantity: number;
  warehouseName: string;
  doctorName: string | null;
  recordedBy: string | null;
  patientName: string;
  visitId: string | null;
}

async function consumptionRows(db: Database, where: ReturnType<typeof and>): Promise<ConsumptionRow[]> {
  const doctor = sql<string | null>`(SELECT display_name FROM users d WHERE d.id = ${stockMovements.doctorId})`;
  const rows = await db
    .select({
      id: stockMovements.id,
      createdAt: stockMovements.createdAt,
      productName: inventoryProducts.name,
      unit: inventoryProducts.unit,
      lotNumber: inventoryBatches.lotNumber,
      expiryDate: inventoryBatches.expiryDate,
      quantity: stockMovements.quantity,
      warehouseName: warehouses.name,
      doctorName: doctor,
      recordedBy: users.displayName,
      firstName: patients.firstName,
      lastName: patients.lastName,
      visitId: stockMovements.visitId,
    })
    .from(stockMovements)
    .innerJoin(inventoryBatches, eq(inventoryBatches.id, stockMovements.batchId))
    .innerJoin(inventoryProducts, eq(inventoryProducts.id, inventoryBatches.productId))
    .innerJoin(warehouses, eq(warehouses.id, stockMovements.warehouseId))
    .innerJoin(patients, eq(patients.id, stockMovements.patientId))
    .leftJoin(users, eq(users.id, stockMovements.createdBy))
    .where(and(eq(stockMovements.movementType, "consumption"), where))
    .orderBy(desc(stockMovements.createdAt));
  return rows.map(({ firstName, lastName, quantity, ...r }) => ({
    ...r,
    quantity: -Number(quantity),
    patientName: `${firstName} ${lastName}`.trim(),
  }));
}

export async function visitConsumption(db: Database, actor: ActorContext, visitId: string): Promise<ConsumptionRow[]> {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_READ, { entityType: "stock_movement", visitId });
  return consumptionRows(db, and(eq(stockMovements.visitId, visitId)));
}

/** Materials used between two dates, for the per-doctor / per-patient totals. */
export async function consumptionBetween(db: Database, actor: ActorContext, from: Date, to: Date): Promise<ConsumptionRow[]> {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_READ, { entityType: "stock_movement" });
  return consumptionRows(db, and(gte(stockMovements.createdAt, from), lt(stockMovements.createdAt, to)));
}
