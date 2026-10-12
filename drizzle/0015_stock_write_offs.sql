-- I5 (ADR-043): returns to supplier and disposals. Additive: one new table, one nullable
-- column, two more movement types (the type check is widened, existing rows all still pass).
-- Rollback (only while no supplier_return/disposal movement exists):
--   ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_type_check;
--   ALTER TABLE stock_movements DROP COLUMN write_off_id;
--   ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_type_check CHECK (movement_type IN
--     ('receipt', 'transfer_out', 'transfer_in', 'consumption', 'adjustment', 'stock_count'));
--   DROP TABLE stock_write_offs;
CREATE TABLE "stock_write_offs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"supplier_id" uuid,
	"reason" text NOT NULL,
	"reference" text,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_write_offs_kind_check" CHECK ("stock_write_offs"."kind" IN ('supplier_return', 'disposal')),
	CONSTRAINT "stock_write_offs_reason_check" CHECK ("stock_write_offs"."reason" IN ('expired', 'damaged', 'recalled', 'other')),
	CONSTRAINT "stock_write_offs_supplier_check" CHECK ("stock_write_offs"."kind" <> 'supplier_return' OR "stock_write_offs"."supplier_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_type_check";--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "write_off_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_write_offs" ADD CONSTRAINT "stock_write_offs_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_write_offs" ADD CONSTRAINT "stock_write_offs_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_write_offs" ADD CONSTRAINT "stock_write_offs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_write_offs_created_idx" ON "stock_write_offs" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_write_off_id_stock_write_offs_id_fk" FOREIGN KEY ("write_off_id") REFERENCES "public"."stock_write_offs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_type_check" CHECK ("stock_movements"."movement_type" IN ('receipt', 'transfer_out', 'transfer_in', 'consumption', 'adjustment', 'stock_count', 'supplier_return', 'disposal'));--> statement-breakpoint
CREATE TRIGGER stock_write_offs_no_update_delete BEFORE UPDATE OR DELETE ON stock_write_offs
FOR EACH ROW EXECUTE FUNCTION r4_prevent_update_delete();
