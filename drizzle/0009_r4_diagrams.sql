-- R4: diagrams and patient file metadata (ADR-033). Additive: three new tables;
-- no change to existing tables. All three are insert-only (triggers below):
-- a saved diagram version or stored file is never replaced or removed.
--
-- Rollback (DESTROYS every diagram and file record; the stored files under
-- FILE_STORAGE_DIR are left untouched and must be handled separately; only
-- with no data to keep, or after a verified backup of the DB and the files):
--   DROP TABLE diagram_versions; DROP TABLE diagrams; DROP TABLE patient_files;
--   DROP FUNCTION r4_prevent_update_delete();

CREATE TABLE "diagram_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"diagram_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"strokes" jsonb NOT NULL,
	"png_file_id" uuid NOT NULL,
	"client_mutation_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diagrams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"patient_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"diagram_type" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"visit_id" uuid,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "diagram_versions" ADD CONSTRAINT "diagram_versions_diagram_id_diagrams_id_fk" FOREIGN KEY ("diagram_id") REFERENCES "public"."diagrams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagram_versions" ADD CONSTRAINT "diagram_versions_png_file_id_patient_files_id_fk" FOREIGN KEY ("png_file_id") REFERENCES "public"."patient_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagram_versions" ADD CONSTRAINT "diagram_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagrams" ADD CONSTRAINT "diagrams_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagrams" ADD CONSTRAINT "diagrams_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagrams" ADD CONSTRAINT "diagrams_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_files" ADD CONSTRAINT "patient_files_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_files" ADD CONSTRAINT "patient_files_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_files" ADD CONSTRAINT "patient_files_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "diagram_versions_diagram_version_idx" ON "diagram_versions" USING btree ("diagram_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "diagram_versions_client_mutation_id_idx" ON "diagram_versions" USING btree ("client_mutation_id");--> statement-breakpoint
CREATE INDEX "diagrams_visit_idx" ON "diagrams" USING btree ("visit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_files_storage_key_idx" ON "patient_files" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "patient_files_patient_idx" ON "patient_files" USING btree ("patient_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION r4_prevent_update_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER patient_files_no_update_delete BEFORE UPDATE OR DELETE ON patient_files
FOR EACH ROW EXECUTE FUNCTION r4_prevent_update_delete();
--> statement-breakpoint
CREATE TRIGGER diagrams_no_update_delete BEFORE UPDATE OR DELETE ON diagrams
FOR EACH ROW EXECUTE FUNCTION r4_prevent_update_delete();
--> statement-breakpoint
CREATE TRIGGER diagram_versions_no_update_delete BEFORE UPDATE OR DELETE ON diagram_versions
FOR EACH ROW EXECUTE FUNCTION r4_prevent_update_delete();
