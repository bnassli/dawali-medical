import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/db/client";
import {
  inventoryBatches,
  inventoryProducts,
  stockCountLines,
  stockCounts,
  stockMovements,
  users,
  warehouses,
} from "@/db/schema";
import { writeAudit } from "@/modules/audit/service";
import { isUniqueViolation, pgErrorField } from "@/modules/clinical/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { requirePermission } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import {
  findOrCreateBatch,
  findOrCreateProduct,
  InventoryError,
  isoDate,
  lockedBalance,
  meta,
  qty,
  text,
} from "./service";

/**
 * I3 (ADR-038): product catalogue (unit, category, reorder level, barcode),
 * stock overview per product, the overview page, and stock counts. The ledger
 * rules of I1 are unchanged: balances are sums of append-only movements.
 */

export const EXPIRY_WARNING_DAYS = 60;

// ---------------------------------------------------------------- catalogue

export interface CatalogProduct {
  id: string;
  name: string;
  unit: string;
  category: string | null;
  minLevel: number | null;
  barcode: string | null;
  isActive: boolean;
  total: number;
  hasMovements: boolean;
}

const productTotal = sql<string>`coalesce((
  SELECT sum(m.quantity) FROM stock_movements m
  JOIN inventory_batches b ON b.id = m.batch_id
  WHERE b.product_id = inventory_products.id), 0)`;
const productHasMovements = sql<boolean>`exists (
  SELECT 1 FROM stock_movements m
  JOIN inventory_batches b ON b.id = m.batch_id
  WHERE b.product_id = inventory_products.id)`;

export async function listCatalog(db: Database, actor: ActorContext): Promise<CatalogProduct[]> {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_READ, { entityType: "inventory_product" });
  const rows = await db
    .select({
      id: inventoryProducts.id,
      name: inventoryProducts.name,
      unit: inventoryProducts.unit,
      category: inventoryProducts.category,
      minLevel: inventoryProducts.minLevel,
      barcode: inventoryProducts.barcode,
      isActive: inventoryProducts.isActive,
      total: productTotal,
      hasMovements: productHasMovements,
    })
    .from(inventoryProducts)
    .orderBy(asc(inventoryProducts.name));
  return rows.map((r) => ({
    ...r,
    minLevel: r.minLevel === null ? null : Number(r.minLevel),
    total: Number(r.total),
  }));
}

const optionalText = (max: number) =>
  text(max).transform((v) => (v === "" ? null : v));

export const productSchema = z.object({
  id: z.string().uuid().nullable(),
  name: text(200).min(1, "Give the product a name."),
  unit: text(40).min(1, "Give the counting unit (vial, piece, box…)."),
  category: optionalText(100),
  minLevel: qty.refine((n) => n >= 0, "The minimum level cannot be negative.").nullable(),
  barcode: optionalText(64),
  isActive: z.boolean(),
});
export type ProductInput = z.input<typeof productSchema>;

function duplicate(err: unknown): InventoryError | null {
  if (!isUniqueViolation(err)) return null;
  return pgErrorField(err, "constraint") === "inventory_products_barcode_idx"
    ? new InventoryError("Another product already has this barcode.", "duplicateBarcode")
    : new InventoryError("A product with this name already exists.", "duplicateName");
}

/** Create or edit a catalogue product (audited). The unit is fixed once stock has moved. */
export async function saveProduct(db: Database, actor: ActorContext, raw: ProductInput): Promise<{ id: string }> {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_MANAGE, { entityType: "inventory_product" });
  const input = productSchema.parse(raw);
  const values = {
    name: input.name,
    unit: input.unit,
    category: input.category,
    minLevel: input.minLevel === null ? null : String(input.minLevel),
    barcode: input.barcode,
    isActive: input.isActive,
  };
  try {
    return await db.transaction(async (tx) => {
      if (input.id === null) {
        const [created] = await tx.insert(inventoryProducts).values({ ...values, createdBy: actor.userId }).returning();
        if (!created) throw new Error("Failed to create product");
        await writeAudit(tx, { actorUserId: actor.userId, action: "inventory_product.create", entityType: "inventory_product", entityId: created.id, after: created, metadata: meta(actor) });
        return { id: created.id };
      }
      const [before] = await tx
        .select({ product: inventoryProducts, hasMovements: productHasMovements })
        .from(inventoryProducts)
        .where(eq(inventoryProducts.id, input.id))
        .for("update", { of: inventoryProducts })
        .limit(1);
      if (!before) throw new InventoryError("Unknown product.", "unknownProduct");
      if (before.hasMovements && before.product.unit !== input.unit) {
        throw new InventoryError("The unit cannot change once the product has stock movements.", "unitLocked");
      }
      const [after] = await tx.update(inventoryProducts).set(values).where(eq(inventoryProducts.id, input.id)).returning();
      await writeAudit(tx, { actorUserId: actor.userId, action: "inventory_product.update", entityType: "inventory_product", entityId: input.id, before: before.product, after, metadata: meta(actor) });
      return { id: input.id };
    });
  } catch (err) {
    throw duplicate(err) ?? err;
  }
}

// ---------------------------------------------------------------- stock overview

export interface BatchBalance {
  warehouseId: string;
  batchId: string;
  productId: string;
  lotNumber: string;
  expiryDate: string | null;
  quantity: number;
}

/** Positive balances of every batch in every store. */
async function batchBalances(db: Database): Promise<BatchBalance[]> {
  const total = sql<string>`sum(${stockMovements.quantity})`;
  const rows = await db
    .select({
      warehouseId: stockMovements.warehouseId,
      batchId: inventoryBatches.id,
      productId: inventoryBatches.productId,
      lotNumber: inventoryBatches.lotNumber,
      expiryDate: inventoryBatches.expiryDate,
      quantity: total,
    })
    .from(stockMovements)
    .innerJoin(inventoryBatches, eq(inventoryBatches.id, stockMovements.batchId))
    .groupBy(stockMovements.warehouseId, inventoryBatches.id)
    .having(sql`${total} > 0`)
    .orderBy(sql`${inventoryBatches.expiryDate} ASC NULLS LAST`, asc(inventoryBatches.lotNumber));
  return rows.map((r) => ({ ...r, quantity: Number(r.quantity) }));
}

export type StockStatus = "out" | "low" | "ok";
export type StockFilter = "all" | "low" | "expiring" | "out";

export interface ProductStock {
  id: string;
  name: string;
  unit: string;
  category: string | null;
  barcode: string | null;
  minLevel: number | null;
  isActive: boolean;
  /** In the chosen store (or all stores). */
  quantity: number;
  /** In all stores: what the minimum level is compared with. */
  total: number;
  status: StockStatus;
  nearestExpiry: string | null;
  batches: BatchBalance[];
}

export function stockStatus(total: number, minLevel: number | null): StockStatus {
  if (total <= 0) return "out";
  if (minLevel !== null && minLevel > 0 && total <= minLevel) return "low";
  return "ok";
}

export function addDays(isoDay: string, days: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * One row per product: quantity in the chosen store, total in all stores,
 * status against the minimum level, and its batches (earliest expiry first).
 * Inactive products appear only while they still have stock.
 */
export async function stockOverview(
  db: Database,
  actor: ActorContext,
  opts: { warehouseId?: string; q?: string; filter?: StockFilter; today: string },
): Promise<ProductStock[]> {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_READ, { entityType: "stock_movement" });
  const [products, balances] = await Promise.all([
    db.select().from(inventoryProducts).orderBy(asc(inventoryProducts.name)),
    batchBalances(db),
  ]);
  const soon = addDays(opts.today, EXPIRY_WARNING_DAYS);
  const needle = opts.q?.trim().toLowerCase() ?? "";
  const out: ProductStock[] = [];
  for (const p of products) {
    const all = balances.filter((b) => b.productId === p.id);
    const here = opts.warehouseId ? all.filter((b) => b.warehouseId === opts.warehouseId) : all;
    const total = all.reduce((s, b) => s + b.quantity, 0);
    if (!p.isActive && total <= 0) continue;
    const minLevel = p.minLevel === null ? null : Number(p.minLevel);
    const row: ProductStock = {
      id: p.id,
      name: p.name,
      unit: p.unit,
      category: p.category,
      barcode: p.barcode,
      minLevel,
      isActive: p.isActive,
      quantity: here.reduce((s, b) => s + b.quantity, 0),
      total,
      status: stockStatus(total, minLevel),
      nearestExpiry: here.find((b) => b.expiryDate !== null)?.expiryDate ?? null,
      batches: here,
    };
    if (needle && ![p.name, p.category ?? "", p.barcode ?? ""].some((v) => v.toLowerCase().includes(needle))) continue;
    if (opts.filter === "low" && row.status !== "low") continue;
    if (opts.filter === "out" && row.status !== "out") continue;
    if (opts.filter === "expiring" && !(row.nearestExpiry !== null && row.nearestExpiry <= soon)) continue;
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------- overview page

export interface MovementView {
  id: string;
  createdAt: Date;
  movementType: string;
  quantity: number;
  productName: string;
  unit: string;
  lotNumber: string;
  warehouseName: string;
  createdBy: string | null;
}

export async function recentMovements(db: Database, actor: ActorContext, limit = 10): Promise<MovementView[]> {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_READ, { entityType: "stock_movement" });
  const rows = await db
    .select({
      id: stockMovements.id,
      createdAt: stockMovements.createdAt,
      movementType: stockMovements.movementType,
      quantity: stockMovements.quantity,
      productName: inventoryProducts.name,
      unit: inventoryProducts.unit,
      lotNumber: inventoryBatches.lotNumber,
      warehouseName: warehouses.name,
      createdBy: users.displayName,
    })
    .from(stockMovements)
    .innerJoin(inventoryBatches, eq(inventoryBatches.id, stockMovements.batchId))
    .innerJoin(inventoryProducts, eq(inventoryProducts.id, inventoryBatches.productId))
    .innerJoin(warehouses, eq(warehouses.id, stockMovements.warehouseId))
    .leftJoin(users, eq(users.id, stockMovements.createdBy))
    .orderBy(desc(stockMovements.createdAt), desc(stockMovements.id))
    .limit(limit);
  return rows.map((r) => ({ ...r, quantity: Number(r.quantity) }));
}

export interface ExpiringBatch extends BatchBalance {
  productName: string;
  unit: string;
  warehouseName: string;
}

export interface InventorySummary {
  activeProducts: number;
  low: ProductStock[];
  expiring: ExpiringBatch[];
  expiredCount: number;
  movements: MovementView[];
}

export async function inventorySummary(db: Database, actor: ActorContext, today: string): Promise<InventorySummary> {
  const [stock, movements, stores] = await Promise.all([
    stockOverview(db, actor, { today }),
    recentMovements(db, actor, 10),
    db.select({ id: warehouses.id, name: warehouses.name }).from(warehouses),
  ]);
  const soon = addDays(today, EXPIRY_WARNING_DAYS);
  const storeName = new Map(stores.map((w) => [w.id, w.name]));
  const expiring: ExpiringBatch[] = [];
  let expiredCount = 0;
  for (const p of stock) {
    for (const b of p.batches) {
      if (b.expiryDate === null || b.expiryDate > soon) continue;
      if (b.expiryDate < today) expiredCount += 1;
      expiring.push({ ...b, productName: p.name, unit: p.unit, warehouseName: storeName.get(b.warehouseId) ?? "" });
    }
  }
  expiring.sort((a, b) => (a.expiryDate ?? "").localeCompare(b.expiryDate ?? ""));
  return {
    activeProducts: stock.filter((p) => p.isActive).length,
    low: stock.filter((p) => p.isActive && p.status !== "ok"),
    expiring,
    expiredCount,
    movements,
  };
}

// ---------------------------------------------------------------- stock count

export interface CountSheet {
  /** Batches with stock in the store, earliest expiry first within a product. */
  batches: (BatchBalance & { productName: string; unit: string })[];
  /** Active products with nothing in this store: counted as new lines. */
  emptyProducts: { id: string; name: string; unit: string }[];
}

export async function countSheet(db: Database, actor: ActorContext, warehouseId: string): Promise<CountSheet> {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_MANAGE, { entityType: "stock_count" });
  const [products, balances] = await Promise.all([
    db.select({ id: inventoryProducts.id, name: inventoryProducts.name, unit: inventoryProducts.unit, isActive: inventoryProducts.isActive }).from(inventoryProducts).orderBy(asc(inventoryProducts.name)),
    batchBalances(db),
  ]);
  const here = balances.filter((b) => b.warehouseId === warehouseId);
  const batches = [];
  const emptyProducts = [];
  for (const p of products) {
    const mine = here.filter((b) => b.productId === p.id);
    for (const b of mine) batches.push({ ...b, productName: p.name, unit: p.unit });
    if (mine.length === 0 && p.isActive) emptyProducts.push({ id: p.id, name: p.name, unit: p.unit });
  }
  return { batches, emptyProducts };
}

const countLineSchema = z.object({
  batchId: z.string().uuid().nullable(),
  productName: text(200),
  unit: text(40),
  lotNumber: text(100),
  expiryDate: isoDate.nullable(),
  countedQuantity: qty.refine((n) => n >= 0, "A counted quantity cannot be negative."),
});

export const stockCountSchema = z.object({
  countId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  notes: text(500),
  lines: z.array(countLineSchema).min(1, "Type at least one counted quantity.").max(2000),
});
export type StockCountInput = z.infer<typeof stockCountSchema>;

/**
 * Post a stock count: each counted batch keeps its system and counted
 * quantities; only differences become 'stock_count' movements. Balances are
 * read under the batch locks at posting time, so a movement made while the
 * count was being typed is not overwritten. Replaying the same countId is a no-op.
 */
export async function postStockCount(
  db: Database,
  actor: ActorContext,
  raw: StockCountInput,
): Promise<{ lines: number; changes: number; replayed: boolean }> {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_MANAGE, { entityType: "stock_count" });
  const input = stockCountSchema.parse(raw);
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: stockCounts.id }).from(stockCounts).where(eq(stockCounts.id, input.countId)).limit(1);
      if (existing) {
        const n = await tx.select({ id: stockCountLines.id }).from(stockCountLines).where(eq(stockCountLines.countId, input.countId));
        return { lines: n.length, changes: 0, replayed: true };
      }
      const [store] = await tx.select({ id: warehouses.id }).from(warehouses).where(and(eq(warehouses.id, input.warehouseId), eq(warehouses.isActive, true))).limit(1);
      if (!store) throw new InventoryError("Unknown store.", "unknownStore");

      // Resolve every line to a batch first.
      const resolved: { batchId: string; counted: number }[] = [];
      const known = input.lines.flatMap((l) => (l.batchId ? [l.batchId] : []));
      const existingBatches = known.length
        ? new Set((await tx.select({ id: inventoryBatches.id }).from(inventoryBatches).where(inArray(inventoryBatches.id, known))).map((b) => b.id))
        : new Set<string>();
      for (const l of input.lines) {
        let batchId = l.batchId;
        if (batchId) {
          if (!existingBatches.has(batchId)) throw new InventoryError("Unknown batch.", "unknownBatch");
        } else {
          if (!l.productName || !l.unit) throw new InventoryError("Give the product name and unit of every new line.", "countLineIncomplete");
          const productId = await findOrCreateProduct(tx, actor, l.productName, l.unit);
          batchId = await findOrCreateBatch(tx, productId, l.lotNumber, l.expiryDate);
        }
        if (resolved.some((r) => r.batchId === batchId)) {
          throw new InventoryError("The same product, lot and expiry is counted twice.", "countDuplicate");
        }
        resolved.push({ batchId, counted: l.countedQuantity });
      }
      // Always lock in the same order (no deadlock with a concurrent count).
      resolved.sort((a, b) => a.batchId.localeCompare(b.batchId));

      await tx.insert(stockCounts).values({ id: input.countId, warehouseId: input.warehouseId, notes: input.notes || null, createdBy: actor.userId });
      let changes = 0;
      const summary = [];
      for (const r of resolved) {
        const system = await lockedBalance(tx, input.warehouseId, r.batchId);
        await tx.insert(stockCountLines).values({ countId: input.countId, batchId: r.batchId, systemQuantity: String(system), countedQuantity: String(r.counted) });
        const diff = Math.round((r.counted - system) * 100) / 100;
        summary.push({ batchId: r.batchId, system, counted: r.counted });
        if (diff === 0) continue;
        changes += 1;
        await tx.insert(stockMovements).values({
          warehouseId: input.warehouseId,
          batchId: r.batchId,
          quantity: String(diff),
          movementType: "stock_count",
          countId: input.countId,
          reason: input.notes ? `Stock count: ${input.notes}` : "Stock count",
          clientMutationId: input.countId,
          createdBy: actor.userId,
        });
      }
      await writeAudit(tx, {
        actorUserId: actor.userId,
        action: "stock.count",
        entityType: "stock_count",
        entityId: input.countId,
        after: { warehouseId: input.warehouseId, notes: input.notes, lines: summary },
        metadata: meta(actor),
      });
      return { lines: resolved.length, changes, replayed: false };
    });
  } catch (err) {
    // Two clicks racing on the same count: the second sees the first's count.
    if (isUniqueViolation(err) && !(err instanceof InventoryError)) {
      const n = await db.select({ id: stockCountLines.id }).from(stockCountLines).where(eq(stockCountLines.countId, input.countId));
      if (n.length > 0) return { lines: n.length, changes: 0, replayed: true };
    }
    throw err;
  }
}
