-- R5: reports and report versions (ADR-034). Additive; both tables insert-only.
-- Rollback (destroys report records; the .docx files in FILE_STORAGE_DIR stay
-- and their patient_files rows stay): DROP TABLE report_versions; DROP TABLE reports;

CREATE TABLE "report_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"content" jsonb NOT NULL,
	"docx_file_id" uuid,
	"client_mutation_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"patient_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"template_code" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_versions" ADD CONSTRAINT "report_versions_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_versions" ADD CONSTRAINT "report_versions_docx_file_id_patient_files_id_fk" FOREIGN KEY ("docx_file_id") REFERENCES "public"."patient_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_versions" ADD CONSTRAINT "report_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_versions_report_version_idx" ON "report_versions" USING btree ("report_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "report_versions_client_mutation_id_idx" ON "report_versions" USING btree ("client_mutation_id");--> statement-breakpoint
CREATE INDEX "reports_visit_idx" ON "reports" USING btree ("visit_id");
--> statement-breakpoint
ALTER TABLE "report_versions" ADD CONSTRAINT "report_versions_status_check" CHECK ("status" IN ('draft', 'final', 'amended'));
--> statement-breakpoint
ALTER TABLE "report_versions" ADD CONSTRAINT "report_versions_file_check" CHECK (("status" = 'draft') = ("docx_file_id" IS NULL));
--> statement-breakpoint
CREATE TRIGGER reports_no_update_delete BEFORE UPDATE OR DELETE ON reports
FOR EACH ROW EXECUTE FUNCTION r4_prevent_update_delete();
--> statement-breakpoint
CREATE TRIGGER report_versions_no_update_delete BEFORE UPDATE OR DELETE ON report_versions
FOR EACH ROW EXECUTE FUNCTION r4_prevent_update_delete();
