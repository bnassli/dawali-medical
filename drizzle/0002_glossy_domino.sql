ALTER TABLE "patients" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "idempotency_key" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "visits_idempotency_key_idx" ON "visits" USING btree ("idempotency_key");--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_status_check" CHECK ("visits"."status" in ('open', 'closed', 'cancelled'));