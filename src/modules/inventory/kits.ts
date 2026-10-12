import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/db/client";
import { inventoryBatches, inventoryProducts, procedureKitItems, procedureKits, stockMovements, visits, warehouses } from "@/db/schema";
import { todayIn } from "@/lib/age";
import { getEnv } from "@/lib/env";
import { writeAudit } from "@/modules/audit/service";
import { isUniqueViolation, pgErrorField, VisitNotFoundError, VisitNotOpenError } from "@/modules/clinical/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { requirePermission } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import { allocateFefo, fefoOrder } from "./fefo";
import { alreadyApplied, InventoryError, listDoctors, lockedBalance, meta, qty, text } from "./service";

/**
 * I4 (ADR-042): procedure kits. A kit lists the usual materials of one
 * procedure; the nurse picks it on the visit, adjusts the quantities if the
 * case differed, and records everything in one step. Each item is taken from
 * the chosen store first-expiry-first, never from an expired batch, and the
 * whole kit is recorded or nothing is (one transaction).
 */

export interface KitItemView {
  productId: string;
  productName: string;
  unit: string;
  quantity: number;
}

export interface KitView {
  id: string;
  name: string;
  isActive: boolean;
  /** For the optimistic check when the kit is edited. */
  updatedAt: string;
  items: KitItemView[];
}

export async function listKits(db: Database, actor: ActorContext, opts: { activeOnly?: boolean } = {}): Promise<KitView[]> {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_READ, { entityType: "procedure_kit" });
  const kits = await db
    .select()
    .from(procedureKits)
    .where(opts.activeOnly ? eq(procedureKits.isActive, true) : undefined)
    .orderBy(asc(sql`lower(${procedureKits.name})`));
  if (kits.length === 0) return [];
  const items = await db
    .select({
      kitId: procedureKitItems.kitId,
      productId: procedureKitItems.productId,
      productName: inventoryProducts.name,
      unit: inventoryProducts.unit,
      quantity: procedureKitItems.quantity,
    })
    .from(procedureKitItems)
    .innerJoin(inventoryProducts, eq(inventoryProducts.id, procedureKitItems.productId))
    .where(inArray(procedureKitItems.kitId, kits.map((k) => k.id)))
    .orderBy(asc(procedureKitItems.sortOrder));
  return kits.map((k) => ({
    id: k.id,
    name: k.name,
    isActive: k.isActive,
    updatedAt: k.updatedAt.toISOString(),
    items: items
      .filter((i) => i.kitId === k.id)
      .map((i) => ({ productId: i.productId, productName: i.productName, unit: i.unit, quantity: Number(i.quantity) })),
  }));
}

// ---------------------------------------------------------------- editing kits

const itemSchema = z.object({
  productId: z.string().uuid(),
  quantity: qty.refine((n) => n > 0, "Quantity must be more than 0."),
});

export const kitSchema = z.object({
  /** Chosen by the screen for a new kit, so a repeated save is not a second kit. */
  id: z.string().uuid(),
  /** null = a new kit; otherwise the updatedAt the editor started from. */
  expectedUpdatedAt: z.string().nullable(),
  name: text(120).min(1, "Give the kit a name (e.g. EVLT)."),
  isActive: z.boolean(),
  items: z
    .array(itemSchema)
    .min(1, "Add at least one item.")
    .max(60, "A kit has at most 60 items.")
    .refine((items) => new Set(items.map((i) => i.productId)).size === items.length, "The same product is in the kit twice."),
});
export type KitInput = z.input<typeof kitSchema>;

/** Create or edit a kit (audited with before/after). A stale edit is refused, never last-write-wins. */
export async function saveKit(db: Database, actor: ActorContext, raw: KitInput): Promise<{ id: string; replayed: boolean }> {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_MANAGE, { entityType: "procedure_kit" });
  const input = kitSchema.parse(raw);
  try {
    return await db.transaction(async (tx) => {
      const products = await tx
        .select({ id: inventoryProducts.id })
        .from(inventoryProducts)
        .where(inArray(inventoryProducts.id, input.items.map((i) => i.productId)));
      if (products.length !== input.items.length) throw new InventoryError("Unknown product.", "unknownProduct");

      const [existing] = await tx.select().from(procedureKits).where(eq(procedureKits.id, input.id)).for("update").limit(1);
      const before = existing ? { ...existing, items: await kitItems(tx, existing.id) } : null;
      if (input.expectedUpdatedAt === null) {
        // A repeated "save" of the same new kit (double click, retry) is a no-op.
        if (existing) {
          if (existing.createdBy !== actor.userId) throw new InventoryError("This kit id was already used.");
          return { id: existing.id, replayed: true };
        }
        await tx.insert(procedureKits).values({ id: input.id, name: input.name, isActive: input.isActive, createdBy: actor.userId });
      } else {
        if (!existing) throw new InventoryError("Unknown kit.", "unknownKit");
        if (existing.updatedAt.toISOString() !== input.expectedUpdatedAt) {
          throw new InventoryError("Someone else changed this kit; reload the page and edit again.", "kitConflict");
        }
        await tx
          .update(procedureKits)
          .set({ name: input.name, isActive: input.isActive, updatedAt: sql`now()` })
          .where(eq(procedureKits.id, input.id));
        await tx.delete(procedureKitItems).where(eq(procedureKitItems.kitId, input.id));
      }
      await tx.insert(procedureKitItems).values(
        input.items.map((i, n) => ({ kitId: input.id, productId: i.productId, quantity: String(i.quantity), sortOrder: n + 1 })),
      );
      const [saved] = await tx.select().from(procedureKits).where(eq(procedureKits.id, input.id));
      await writeAudit(tx, {
        actorUserId: actor.userId,
        action: before ? "procedure_kit.update" : "procedure_kit.create",
        entityType: "procedure_kit",
        entityId: input.id,
        before,
        after: { ...saved, items: input.items },
        metadata: meta(actor),
      });
      return { id: input.id, replayed: false };
    });
  } catch (err) {
    if (isUniqueViolation(err) && pgErrorField(err, "constraint") === "procedure_kits_lower_name_idx") {
      throw new InventoryError("A kit with this name already exists.", "duplicateKitName");
    }
    throw err;
  }
}

async function kitItems(tx: Database, kitId: string) {
  return tx
    .select({ productId: procedureKitItems.productId, quantity: procedureKitItems.quantity })
    .from(procedureKitItems)
    .where(eq(procedureKitItems.kitId, kitId))
    .orderBy(asc(procedureKitItems.sortOrder));
}

// ---------------------------------------------------------------- using a kit

export class KitShortageError extends InventoryError {
  constructor(readonly shortages: { productName: string; unit: string; needed: number; available: number }[]) {
    super(
      `Not enough usable stock in this store: ${shortages
        .map((s) => `${s.productName} needs ${s.needed} ${s.unit}, ${s.available} available`)
        .join("; ")}. Nothing was recorded.`,
    );
    this.name = "KitShortageError";
  }
}

export const issueSchema = z.object({
  clientMutationId: z.string().uuid(),
  visitId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  doctorId: z.string().uuid(),
  kitId: z.string().uuid().nullable(),
  items: z.array(itemSchema).min(1, "Nothing to record.").max(60),
});
export type IssueInput = z.input<typeof issueSchema>;

export interface IssuedLine {
  productName: string;
  unit: string;
  lotNumber: string;
  expiryDate: string | null;
  quantity: number;
}

/**
 * Records a kit (or several items at once) on the visit's patient and the
 * treating doctor. All items or none: a shortage of any item records nothing.
 */
export async function issueToVisit(db: Database, actor: ActorContext, raw: IssueInput): Promise<{ replayed: boolean; lines: IssuedLine[] }> {
  await requirePermission(db, actor, PERMISSIONS.INVENTORY_CONSUME, { entityType: "stock_movement", visitId: raw.visitId });
  const input = issueSchema.parse(raw);
  const doctors = await listDoctors(db);
  if (!doctors.some((d) => d.id === input.doctorId)) throw new InventoryError("Choose the treating doctor.");
  // The same product twice (e.g. an extra line) is one need.
  const need = new Map<string, number>();
  for (const i of input.items) need.set(i.productId, Math.round(((need.get(i.productId) ?? 0) + i.quantity) * 100) / 100);
  const today = todayIn(getEnv().APP_TIME_ZONE);
  try {
    return await db.transaction(async (tx) => {
      // Serialise requests carrying the same id (double click, retry) before
      // the replay check: a kit's batches are chosen at run time, so the
      // per-batch unique index alone would not stop a second request that
      // moved on to the next batch.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mutation:${input.clientMutationId}`}, 0))`);
      if (await alreadyApplied(tx, input.clientMutationId)) return { replayed: true, lines: [] };
      const [visit] = await tx
        .select({ id: visits.id, patientId: visits.patientId, status: visits.status })
        .from(visits)
        .where(eq(visits.id, input.visitId))
        .limit(1);
      if (!visit) throw new VisitNotFoundError(input.visitId);
      if (visit.status !== "open") throw new VisitNotOpenError(visit.id, visit.status);
      const [store] = await tx.select({ id: warehouses.id, name: warehouses.name }).from(warehouses).where(eq(warehouses.id, input.warehouseId)).limit(1);
      if (!store) throw new InventoryError("Unknown store.", "unknownStore");
      let kitName: string | null = null;
      if (input.kitId) {
        const [kit] = await tx.select().from(procedureKits).where(eq(procedureKits.id, input.kitId)).limit(1);
        if (!kit || !kit.isActive) throw new InventoryError("This kit is not in use any more.", "unknownKit");
        kitName = kit.name;
      }

      const lines: (IssuedLine & { batchId: string })[] = [];
      const shortages: KitShortageError["shortages"] = [];
      // A fixed product order, and FEFO order within a product, so concurrent
      // issues take the batch locks in the same order.
      for (const productId of [...need.keys()].sort()) {
        const quantity = need.get(productId)!;
        const [product] = await tx.select().from(inventoryProducts).where(eq(inventoryProducts.id, productId)).limit(1);
        if (!product) throw new InventoryError("Unknown product.", "unknownProduct");
        const candidates = await tx
          .selectDistinct({ batchId: inventoryBatches.id, lotNumber: inventoryBatches.lotNumber, expiryDate: inventoryBatches.expiryDate })
          .from(stockMovements)
          .innerJoin(inventoryBatches, eq(inventoryBatches.id, stockMovements.batchId))
          .where(and(eq(stockMovements.warehouseId, store.id), eq(inventoryBatches.productId, productId)));
        const usable = fefoOrder(candidates.filter((c) => c.expiryDate === null || c.expiryDate >= today));
        const balances = [];
        for (const c of usable) balances.push({ ...c, quantity: await lockedBalance(tx, store.id, c.batchId) });
        const { takes, short } = allocateFefo(balances, quantity, today);
        if (short > 0) {
          const available = balances.reduce((n, b) => n + Math.max(b.quantity, 0), 0);
          shortages.push({ productName: product.name, unit: product.unit, needed: quantity, available: Math.round(available * 100) / 100 });
          continue;
        }
        for (const t of takes) {
          const b = balances.find((x) => x.batchId === t.batchId)!;
          lines.push({ batchId: t.batchId, productName: product.name, unit: product.unit, lotNumber: b.lotNumber, expiryDate: b.expiryDate, quantity: t.quantity });
        }
      }
      if (shortages.length > 0) throw new KitShortageError(shortages);

      await tx.insert(stockMovements).values(
        lines.map((l) => ({
          warehouseId: store.id,
          batchId: l.batchId,
          quantity: String(-l.quantity),
          movementType: "consumption",
          visitId: visit.id,
          patientId: visit.patientId,
          doctorId: input.doctorId,
          kitId: input.kitId,
          clientMutationId: input.clientMutationId,
          createdBy: actor.userId,
        })),
      );
      await writeAudit(tx, {
        actorUserId: actor.userId,
        action: "stock.consume_kit",
        entityType: "visit",
        entityId: visit.id,
        patientId: visit.patientId,
        visitId: visit.id,
        after: { kitId: input.kitId, kitName, warehouse: store.name, doctorId: input.doctorId, lines },
        metadata: meta(actor),
      });
      return {
        replayed: false,
        lines: lines.map((l) => ({ productName: l.productName, unit: l.unit, lotNumber: l.lotNumber, expiryDate: l.expiryDate, quantity: l.quantity })),
      };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { replayed: true, lines: [] };
    throw err;
  }
}
