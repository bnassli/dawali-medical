CREATE TABLE "clinical_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visit_id" uuid NOT NULL,
	"field_definition_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"value" jsonb NOT NULL,
	"client_mutation_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clinical_field_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"field_type" text NOT NULL,
	"option_list_id" uuid,
	"allows_free_text" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "clinical_field_definitions_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "clinical_option_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "clinical_option_lists_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "clinical_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clinical_section_fields" (
	"section_id" uuid NOT NULL,
	"field_definition_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	CONSTRAINT "clinical_section_fields_section_id_field_definition_id_pk" PRIMARY KEY("section_id","field_definition_id")
);
--> statement-breakpoint
CREATE TABLE "clinical_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer NOT NULL,
	CONSTRAINT "clinical_sections_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "clinical_entries" ADD CONSTRAINT "clinical_entries_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_entries" ADD CONSTRAINT "clinical_entries_field_definition_id_clinical_field_definitions_id_fk" FOREIGN KEY ("field_definition_id") REFERENCES "public"."clinical_field_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_entries" ADD CONSTRAINT "clinical_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_field_definitions" ADD CONSTRAINT "clinical_field_definitions_option_list_id_clinical_option_lists_id_fk" FOREIGN KEY ("option_list_id") REFERENCES "public"."clinical_option_lists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_options" ADD CONSTRAINT "clinical_options_list_id_clinical_option_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."clinical_option_lists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_options" ADD CONSTRAINT "clinical_options_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_section_fields" ADD CONSTRAINT "clinical_section_fields_section_id_clinical_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."clinical_sections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_section_fields" ADD CONSTRAINT "clinical_section_fields_field_definition_id_clinical_field_definitions_id_fk" FOREIGN KEY ("field_definition_id") REFERENCES "public"."clinical_field_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_entries_visit_field_version_idx" ON "clinical_entries" USING btree ("visit_id","field_definition_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_entries_client_mutation_id_idx" ON "clinical_entries" USING btree ("client_mutation_id") WHERE "clinical_entries"."client_mutation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "clinical_entries_visit_id_idx" ON "clinical_entries" USING btree ("visit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_options_list_id_lower_label_idx" ON "clinical_options" USING btree ("list_id",lower("label"));--> statement-breakpoint
CREATE INDEX "clinical_section_fields_field_idx" ON "clinical_section_fields" USING btree ("field_definition_id");