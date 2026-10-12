-- I4 (ADR-042): procedure kits. Additive only (two new tables, one nullable column).
-- Rollback: ALTER TABLE stock_movements DROP COLUMN kit_id;
-- DROP TABLE procedure_kit_items; DROP TABLE procedure_kits.
-- Order: merge after 0013_visit_staff (PR #15); the migrator applies by timestamp.
CREATE TABLE "procedure_kit_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kit_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" numeric(12, 2) NOT NULL,
	"sort_order" integer NOT NULL,
	CONSTRAINT "procedure_kit_items_quantity_check" CHECK ("procedure_kit_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "procedure_kits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "kit_id" uuid;--> statement-breakpoint
ALTER TABLE "procedure_kit_items" ADD CONSTRAINT "procedure_kit_items_kit_id_procedure_kits_id_fk" FOREIGN KEY ("kit_id") REFERENCES "public"."procedure_kits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure_kit_items" ADD CONSTRAINT "procedure_kit_items_product_id_inventory_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."inventory_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure_kits" ADD CONSTRAINT "procedure_kits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "procedure_kit_items_kit_product_idx" ON "procedure_kit_items" USING btree ("kit_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "procedure_kits_lower_name_idx" ON "procedure_kits" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kit_id_procedure_kits_id_fk" FOREIGN KEY ("kit_id") REFERENCES "public"."procedure_kits"("id") ON DELETE restrict ON UPDATE no action;