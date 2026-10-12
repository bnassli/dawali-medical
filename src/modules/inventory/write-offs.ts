import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/db/client";
import {
  inventoryBatches,
  inventoryProducts,
  stockMovements,
  stockWriteOffs,
  suppliers,
  users,
  warehouses,
} from "@/db/schema";
import { writeAudit } from "@/modules/audit/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { requirePermission } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import { InventoryError, lockedBalance, meta, qty, text } from "./service";
import { WRITE_OFF_KINDS, WRITE_OFF_REASONS, type WriteOffKind, type WriteOffReason } from "./write-off-kinds";

/**
 * I5 (ADR-043): returns to the supplier and disposals. The storekeeper lists
 * the batches leaving the store (expired, damaged, recalled...), with the
 * supplier's return reference for a return. All lines or none; a line can
 * never take more than the batch holds; one audit entry per document.
 */

export class WriteOffShortageError extends InventoryError {
  constructor(
    readonly productName: string,
    readonly lotNumber: string,
    readonly available: number,
    readonly unit: string,
  ) {
    super(`Not enough ${productName} (lot ${lotNumber || "—"}) in this store: only ${available} ${unit}. Nothing was recorded.`);
    this.name = "WriteOffShortageError";
  }
}

const optional = (max: number) =>
  text(max)
    .nullable()
    .transform((v) => (v ? v : null));

export const writeOffSchema = z
  .object({
    /** Chosen by the screen, so a repeated submit is not a second document. */
    id: z.string().uuid(),
    kind: z.enum(WRITE_OFF_KINDS),
    warehouseId: z.string().uuid(),
    supplierId: z.string().uuid().nullable(),
    reason: z.enum(WRITE_OFF_REASONS),
    reference: optional(100),
    notes: optional(500),
    lines: z
      .array(z.object({ batchId: z.string().uuid(), quantity: qty.refine((n) => n > 0, "Quantity must be more than 0.") }))
      .min(1, "Add at least one line.")
      .max(100)
      .refine((ls) => new Set(ls.map((l) => l.batchId)).size === ls.length, "The same batch is listed twice."),
  })
  .refine((w) => w.kind !== "supplier_return" || w.supplierId !== null, { message: "Choose the supplier the stock goes back to.", path: ["supplierId"] });
export type WriteOffInput = z.input<typeof writeOffSchema>;

export async function postWriteOff(db: Database, actor: ActorContext, raw: WriteOffInput): Promise<{ id: string; replayed: boolean; lines: number }> {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_MANAGE, { entityType: "stock_write_off" });
  const input = writeOffSchema.parse(raw);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`write_off:${input.id}`}, 0))`);
    const [existing] = await tx.select().from(stockWriteOffs).where(eq(stockWriteOffs.id, input.id)).limit(1);
    if (existing) {
      if (existing.createdBy !== actor.userId) throw new InventoryError("This document id was already used.");
      return { id: existing.id, replayed: true, lines: 0 };
    }
    const [store] = await tx.select().from(warehouses).where(eq(warehouses.id, input.warehouseId)).limit(1);
    if (!store) throw new InventoryError("Unknown store.", "unknownStore");
    const supplierId = input.kind === "supplier_return" ? input.supplierId : null;
    let supplierName: string | null = null;
    if (supplierId) {
      const [s] = await tx.select().from(suppliers).where(eq(suppliers.id, supplierId)).limit(1);
      if (!s) throw new InventoryError("Unknown supplier.", "unknownSupplier");
      supplierName = s.name;
    }
    const batches = await tx
      .select({ id: inventoryBatches.id, lotNumber: inventoryBatches.lotNumber, expiryDate: inventoryBatches.expiryDate, productName: inventoryProducts.name, unit: inventoryProducts.unit })
      .from(inventoryBatches)
      .innerJoin(inventoryProducts, eq(inventoryProducts.id, inventoryBatches.productId))
      .where(inArray(inventoryBatches.id, input.lines.map((l) => l.batchId)));
    if (batches.length !== input.lines.length) throw new InventoryError("Unknown batch.", "unknownBatch");

    // A fixed lock order (by batch id), as everywhere else in the ledger.
    const lines = [...input.lines].sort((a, b) => (a.batchId < b.batchId ? -1 : 1));
    for (const l of lines) {
      const b = batches.find((x) => x.id === l.batchId)!;
      const balance = await lockedBalance(tx, store.id, l.batchId);
      if (balance < l.quantity) throw new WriteOffShortageError(b.productName, b.lotNumber, Math.max(balance, 0), b.unit);
    }
    await tx.insert(stockWriteOffs).values({
      id: input.id,
      kind: input.kind,
      warehouseId: store.id,
      supplierId,
      reason: input.reason,
      reference: input.reference,
      notes: input.notes,
      createdBy: actor.userId,
    });
    await tx.insert(stockMovements).values(
      lines.map((l) => ({
        warehouseId: store.id,
        batchId: l.batchId,
        quantity: String(-l.quantity),
        movementType: input.kind,
        reason: input.reason,
        writeOffId: input.id,
        clientMutationId: input.id,
        createdBy: actor.userId,
      })),
    );
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "stock.write_off",
      entityType: "stock_write_off",
      entityId: input.id,
      after: {
        ...input,
        supplierId,
        store: store.name,
        supplier: supplierName,
        lines: lines.map((l) => {
          const b = batches.find((x) => x.id === l.batchId)!;
          return { ...l, product: b.productName, lot: b.lotNumber, expiryDate: b.expiryDate, unit: b.unit };
        }),
      },
      metadata: meta(actor),
    });
    return { id: input.id, replayed: false, lines: lines.length };
  });
}

// ---------------------------------------------------------------- history

export interface WriteOffLineView {
  productName: string;
  unit: string;
  lotNumber: string;
  expiryDate: string | null;
  quantity: number;
  /** Weighted invoice cost of one unit (ex VAT); null when never invoiced with a price. */
  unitCost: number | null;
}

export interface WriteOffView {
  id: string;
  kind: WriteOffKind;
  reason: WriteOffReason;
  warehouseName: string;
  supplierName: string | null;
  reference: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: Date;
  lines: WriteOffLineView[];
  /** Sum of the priced lines. */
  value: number;
  unpricedLines: number;
}

/** The latest documents, newest first, with their value at invoice cost. */
export async function listWriteOffs(db: Database, actor: ActorContext, limit = 50): Promise<WriteOffView[]> {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_MANAGE, { entityType: "stock_write_off" });
  const docs = await db
    .select({
      id: stockWriteOffs.id,
      kind: stockWriteOffs.kind,
      reason: stockWriteOffs.reason,
      warehouseName: warehouses.name,
      supplierName: suppliers.name,
      reference: stockWriteOffs.reference,
      notes: stockWriteOffs.notes,
      createdBy: users.displayName,
      createdAt: stockWriteOffs.createdAt,
    })
    .from(stockWriteOffs)
    .innerJoin(warehouses, eq(warehouses.id, stockWriteOffs.warehouseId))
    .leftJoin(suppliers, eq(suppliers.id, stockWriteOffs.supplierId))
    .leftJoin(users, eq(users.id, stockWriteOffs.createdBy))
    .orderBy(desc(stockWriteOffs.createdAt))
    .limit(limit);
  if (docs.length === 0) return [];
  const unitCost = sql<string | null>`(
    SELECT sum(l.unit_cost * l.quantity) / nullif(sum(l.quantity * l.pack_size), 0)
    FROM purchase_receipt_lines l
    WHERE l.batch_id = ${stockMovements.batchId} AND l.unit_cost IS NOT NULL)`;
  const lines = await db
    .select({
      writeOffId: stockMovements.writeOffId,
      productName: inventoryProducts.name,
      unit: inventoryProducts.unit,
      lotNumber: inventoryBatches.lotNumber,
      expiryDate: inventoryBatches.expiryDate,
      quantity: stockMovements.quantity,
      unitCost,
    })
    .from(stockMovements)
    .innerJoin(inventoryBatches, eq(inventoryBatches.id, stockMovements.batchId))
    .innerJoin(inventoryProducts, eq(inventoryProducts.id, inventoryBatches.productId))
    .where(inArray(stockMovements.writeOffId, docs.map((d) => d.id)))
    .orderBy(asc(inventoryProducts.name), asc(inventoryBatches.lotNumber));
  return docs.map((d) => {
    const mine: WriteOffLineView[] = lines
      .filter((l) => l.writeOffId === d.id)
      .map((l) => ({
        productName: l.productName,
        unit: l.unit,
        lotNumber: l.lotNumber,
        expiryDate: l.expiryDate,
        quantity: -Number(l.quantity),
        unitCost: l.unitCost === null ? null : Number(l.unitCost),
      }));
    const value = mine.reduce((n, l) => n + (l.unitCost === null ? 0 : l.unitCost * l.quantity), 0);
    return {
      ...d,
      kind: d.kind as WriteOffKind,
      reason: d.reason as WriteOffReason,
      lines: mine,
      value: Math.round(value * 100) / 100,
      unpricedLines: mine.filter((l) => l.unitCost === null).length,
    };
  });
}

/** The supplier each batch was last received from (to suggest it on a return). */
export async function lastSupplierByBatch(db: Database, actor: ActorContext): Promise<Map<string, string>> {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_MANAGE, { entityType: "supplier" });
  const rows = await db.execute<{ batch_id: string; supplier_id: string }>(sql`
    SELECT DISTINCT ON (l.batch_id) l.batch_id, r.supplier_id
    FROM purchase_receipt_lines l JOIN purchase_receipts r ON r.id = l.receipt_id
    WHERE r.supplier_id IS NOT NULL
    ORDER BY l.batch_id, r.created_at DESC`);
  return new Map(rows.rows.map((r) => [r.batch_id, r.supplier_id]));
}
