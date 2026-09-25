-- R2: Treatment Plan (ADR-030). Additive: two new tables, no change to existing
-- tables or data. Both tables are append-only (triggers at the end).
--
-- Rollback (only while no plan data must be kept, or after a verified backup;
-- it DESTROYS every Treatment Plan row):
--   DROP TABLE treatment_plan_entries;
--   DROP TABLE treatment_plan_items;
--   DROP FUNCTION treatment_plan_prevent_update_delete();
-- The seeded column fields, option lists and the "treatment_plan" section can
-- stay (unused) or be retired with is_active = false; nothing else depends on them.

CREATE TABLE "treatment_plan_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"field_definition_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"value" jsonb NOT NULL,
	"visit_id" uuid NOT NULL,
	"client_mutation_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treatment_plan_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"patient_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_in_visit_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "treatment_plan_entries" ADD CONSTRAINT "treatment_plan_entries_item_id_treatment_plan_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."treatment_plan_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_entries" ADD CONSTRAINT "treatment_plan_entries_field_definition_id_clinical_field_definitions_id_fk" FOREIGN KEY ("field_definition_id") REFERENCES "public"."clinical_field_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_entries" ADD CONSTRAINT "treatment_plan_entries_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_entries" ADD CONSTRAINT "treatment_plan_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_items" ADD CONSTRAINT "treatment_plan_items_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_items" ADD CONSTRAINT "treatment_plan_items_created_in_visit_id_visits_id_fk" FOREIGN KEY ("created_in_visit_id") REFERENCES "public"."visits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_items" ADD CONSTRAINT "treatment_plan_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_plan_entries_item_field_version_idx" ON "treatment_plan_entries" USING btree ("item_id","field_definition_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_plan_entries_client_mutation_id_idx" ON "treatment_plan_entries" USING btree ("client_mutation_id");--> statement-breakpoint
CREATE INDEX "treatment_plan_entries_item_id_idx" ON "treatment_plan_entries" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_plan_items_patient_position_idx" ON "treatment_plan_items" USING btree ("patient_id","position");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION treatment_plan_prevent_update_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER treatment_plan_items_no_update_delete
BEFORE UPDATE OR DELETE ON treatment_plan_items
FOR EACH ROW
EXECUTE FUNCTION treatment_plan_prevent_update_delete();
--> statement-breakpoint
CREATE TRIGGER treatment_plan_entries_no_update_delete
BEFORE UPDATE OR DELETE ON treatment_plan_entries
FOR EACH ROW
EXECUTE FUNCTION treatment_plan_prevent_update_delete();
