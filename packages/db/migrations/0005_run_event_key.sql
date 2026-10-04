ALTER TABLE "run_event" ADD COLUMN "key" text;--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_run_key_uq" UNIQUE("run_id","key");