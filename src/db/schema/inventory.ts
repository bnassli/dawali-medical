import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./core";
import { patients } from "./patients";
import { visits } from "./visits";

/**
 * Inventory I1 (ADR-035). Stock is never stored as a number that gets
 * overwritten: the balance of a batch in a warehouse is the SUM of its
 * append-only stock movements. Expiry belongs to the batch, not the product.
 */

/** The two stores (Operations, Clinic); seeded, identified by code. */
export const warehouses = pgTable("warehouses", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
});

export const inventoryProducts = pgTable(
  "inventory_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // Counting unit: "vial", "ml", "pair", "box", "piece"...
    unit: text("unit").notNull(),
    category: text("category"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("inventory_products_lower_name_idx").on(sql`lower(${t.name})`)],
);

export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("suppliers_lower_name_idx").on(sql`lower(${t.name})`)],
);

/** A lot of one product; "" lot = no lot number printed. Insert-only. */
export const inventoryBatches = pgTable(
  "inventory_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => inventoryProducts.id, { onDelete: "restrict" }),
    lotNumber: text("lot_number").notNull(),
    expiryDate: date("expiry_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("inventory_batches_identity_idx").on(t.productId, t.lotNumber, sql`coalesce(${t.expiryDate}, '0001-01-01')`),
  ],
);

/** What the AI read from a scanned invoice; always reviewed by a person before stock is posted. */
export interface ExtractedInvoice {
  /** "statement" (statement of account) and "other" documents are never received into stock. */
  documentType: "invoice" | "statement" | "other";
  supplierName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  lines: {
    productName: string;
    lotNumber: string | null;
    expiryDate: string | null;
    /** Number of packs as invoiced ("10.00 box of 5" -> 10). */
    quantity: number | null;
    /** Units in one pack ("box of 5" -> 5); stock is counted in units. */
    packSize: number | null;
    unit: string | null;
    /** Price of one pack before VAT. */
    unitCost: number | null;
  }[];
}

/**
 * A scanned purchase invoice (image or PDF) kept privately in file storage,
 * with the AI's reading of it (or the error). Insert-only.
 */
export const invoiceScans = pgTable("invoice_scans", {
  id: uuid("id").primaryKey().defaultRandom(),
  storageKey: text("storage_key").notNull().unique(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: text("sha256").notNull(),
  extracted: jsonb("extracted").$type<ExtractedInvoice>(),
  extractionError: text("extraction_error"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A purchase invoice as received. The client chooses the id (idempotent). Insert-only. */
export const purchaseReceipts = pgTable("purchase_receipts", {
  id: uuid("id").primaryKey(),
  supplierId: uuid("supplier_id").references(() => suppliers.id, { onDelete: "restrict" }),
  invoiceNumber: text("invoice_number").notNull(),
  invoiceDate: date("invoice_date").notNull(),
  warehouseId: uuid("warehouse_id")
    .notNull()
    .references(() => warehouses.id, { onDelete: "restrict" }),
  notes: text("notes"),
  // The scan it was confirmed from, when it came in through the scanner + AI.
  scanId: uuid("scan_id").references(() => invoiceScans.id, { onDelete: "restrict" }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const purchaseReceiptLines = pgTable(
  "purchase_receipt_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => purchaseReceipts.id, { onDelete: "restrict" }),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => inventoryBatches.id, { onDelete: "restrict" }),
    // Packs as invoiced; the stock receives quantity x pack_size units.
    quantity: numeric("quantity", { precision: 12, scale: 2 }).notNull(),
    packSize: numeric("pack_size", { precision: 12, scale: 2 }).notNull().default("1"),
    // Price of one pack before VAT.
    unitCost: numeric("unit_cost", { precision: 12, scale: 2 }),
  },
  (t) => [
    check("purchase_receipt_lines_quantity_check", sql`${t.quantity} > 0`),
    check("purchase_receipt_lines_pack_size_check", sql`${t.packSize} > 0`),
  ],
);

export const MOVEMENT_TYPES = ["receipt", "transfer_out", "transfer_in", "consumption", "adjustment"] as const;

/**
 * The stock ledger. Every change of stock is one row (+ in, - out); rows are
 * never changed or removed (trigger); a mistake is corrected by another row.
 */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => inventoryBatches.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 12, scale: 2 }).notNull(),
    movementType: text("movement_type").notNull(),
    receiptId: uuid("receipt_id").references(() => purchaseReceipts.id, { onDelete: "restrict" }),
    // Pairs the two rows of one transfer.
    transferId: uuid("transfer_id"),
    visitId: uuid("visit_id").references(() => visits.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").references(() => patients.id, { onDelete: "restrict" }),
    // Consumption is charged to the doctor as well as the patient.
    doctorId: uuid("doctor_id").references(() => users.id, { onDelete: "restrict" }),
    reason: text("reason"),
    clientMutationId: uuid("client_mutation_id").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("stock_movements_balance_idx").on(t.warehouseId, t.batchId),
    index("stock_movements_visit_idx").on(t.visitId),
    index("stock_movements_doctor_idx").on(t.doctorId),
    uniqueIndex("stock_movements_mutation_type_idx").on(t.clientMutationId, t.movementType, t.batchId),
    check("stock_movements_quantity_check", sql`${t.quantity} <> 0`),
    check(
      "stock_movements_type_check",
      sql`${t.movementType} IN ('receipt', 'transfer_out', 'transfer_in', 'consumption', 'adjustment')`,
    ),
  ],
);
