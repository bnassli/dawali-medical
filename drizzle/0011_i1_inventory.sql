-- I1: inventory (ADR-035). Additive: new tables only. The stock ledger, batches,
-- invoice scans, receipts and their lines are insert-only (triggers); products,
-- suppliers and warehouses may change name/active flag. Seeds the two stores.
--
-- Rollback (destroys all inventory data; scanned invoices in FILE_STORAGE_DIR
-- stay; only with nothing to keep, or after a verified backup):
-- DROP TABLE stock_movements, purchase_receipt_lines, purchase_receipts,
-- invoice_scans, inventory_batches, suppliers, inventory_products, warehouses;

CREATE TABLE "inventory_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"lot_number" text NOT NULL,
	"expiry_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"category" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"extracted" jsonb,
	"extraction_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_scans_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "purchase_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"quantity" numeric(12, 2) NOT NULL,
	"pack_size" numeric(12, 2) DEFAULT '1' NOT NULL,
	"unit_cost" numeric(12, 2),
	CONSTRAINT "purchase_receipt_lines_quantity_check" CHECK ("purchase_receipt_lines"."quantity" > 0),
	CONSTRAINT "purchase_receipt_lines_pack_size_check" CHECK ("purchase_receipt_lines"."pack_size" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid,
	"invoice_number" text NOT NULL,
	"invoice_date" date NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"notes" text,
	"scan_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"quantity" numeric(12, 2) NOT NULL,
	"movement_type" text NOT NULL,
	"receipt_id" uuid,
	"transfer_id" uuid,
	"visit_id" uuid,
	"patient_id" uuid,
	"doctor_id" uuid,
	"reason" text,
	"client_mutation_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_quantity_check" CHECK ("stock_movements"."quantity" <> 0),
	CONSTRAINT "stock_movements_type_check" CHECK ("stock_movements"."movement_type" IN ('receipt', 'transfer_out', 'transfer_in', 'consumption', 'adjustment'))
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "warehouses_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_product_id_inventory_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."inventory_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_products" ADD CONSTRAINT "inventory_products_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_scans" ADD CONSTRAINT "invoice_scans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_receipt_id_purchase_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."purchase_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_batch_id_inventory_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."inventory_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_scan_id_invoice_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."invoice_scans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_batch_id_inventory_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."inventory_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_receipt_id_purchase_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."purchase_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_doctor_id_users_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_batches_identity_idx" ON "inventory_batches" USING btree ("product_id","lot_number",coalesce("expiry_date", '0001-01-01'));--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_products_lower_name_idx" ON "inventory_products" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "stock_movements_balance_idx" ON "stock_movements" USING btree ("warehouse_id","batch_id");--> statement-breakpoint
CREATE INDEX "stock_movements_visit_idx" ON "stock_movements" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "stock_movements_doctor_idx" ON "stock_movements" USING btree ("doctor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_mutation_type_idx" ON "stock_movements" USING btree ("client_mutation_id","movement_type","batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_lower_name_idx" ON "suppliers" USING btree (lower("name"));
--> statement-breakpoint
INSERT INTO "warehouses" ("code", "name") VALUES
  ('operations', 'Operations Store (مستودع العمليات)'),
  ('clinic', 'Clinic Store (مستودع العيادة)')
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
CREATE TRIGGER stock_movements_no_update_delete BEFORE UPDATE OR DELETE ON stock_movements
FOR EACH ROW EXECUTE FUNCTION r4_prevent_update_delete();
--> statement-breakpoint
CREATE TRIGGER inventory_batches_no_update_delete BEFORE UPDATE OR DELETE ON inventory_batches
FOR EACH ROW EXECUTE FUNCTION r4_prevent_update_delete();
--> statement-breakpoint
CREATE TRIGGER invoice_scans_no_update_delete BEFORE UPDATE OR DELETE ON invoice_scans
FOR EACH ROW EXECUTE FUNCTION r4_prevent_update_delete();
--> statement-breakpoint
CREATE TRIGGER purchase_receipts_no_update_delete BEFORE UPDATE OR DELETE ON purchase_receipts
FOR EACH ROW EXECUTE FUNCTION r4_prevent_update_delete();
--> statement-breakpoint
CREATE TRIGGER purchase_receipt_lines_no_update_delete BEFORE UPDATE OR DELETE ON purchase_receipt_lines
FOR EACH ROW EXECUTE FUNCTION r4_prevent_update_delete();
