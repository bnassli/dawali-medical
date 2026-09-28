-- I3 (ADR-038): product reorder level + barcode, stock counts. Additive only.
-- Rollback: DROP TABLE stock_count_lines, stock_counts (after dropping stock_movements.count_id);
-- DROP COLUMN min_level, barcode; restore the previous stock_movements_type_check.
CREATE TABLE "stock_count_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"count_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"system_quantity" numeric(12, 2) NOT NULL,
	"counted_quantity" numeric(12, 2) NOT NULL,
	CONSTRAINT "stock_count_lines_counted_check" CHECK ("stock_count_lines"."counted_quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_type_check";--> statement-breakpoint
ALTER TABLE "inventory_products" ADD COLUMN "min_level" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "inventory_products" ADD COLUMN "barcode" text;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "count_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_count_id_stock_counts_id_fk" FOREIGN KEY ("count_id") REFERENCES "public"."stock_counts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_batch_id_inventory_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."inventory_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_count_lines_count_batch_idx" ON "stock_count_lines" USING btree ("count_id","batch_id");--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_count_id_stock_counts_id_fk" FOREIGN KEY ("count_id") REFERENCES "public"."stock_counts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_products_barcode_idx" ON "inventory_products" USING btree ("barcode") WHERE "inventory_products"."barcode" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_products" ADD CONSTRAINT "inventory_products_min_level_check" CHECK ("inventory_products"."min_level" IS NULL OR "inventory_products"."min_level" >= 0);--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_type_check" CHECK ("stock_movements"."movement_type" IN ('receipt', 'transfer_out', 'transfer_in', 'consumption', 'adjustment', 'stock_count'));--> statement-breakpoint
CREATE TRIGGER stock_counts_no_update_delete BEFORE UPDATE OR DELETE ON stock_counts
FOR EACH ROW EXECUTE FUNCTION r4_prevent_update_delete();--> statement-breakpoint
CREATE TRIGGER stock_count_lines_no_update_delete BEFORE UPDATE OR DELETE ON stock_count_lines
FOR EACH ROW EXECUTE FUNCTION r4_prevent_update_delete();
