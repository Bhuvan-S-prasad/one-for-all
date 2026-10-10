ALTER TABLE "approval" ADD COLUMN "editable" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "approval" ADD COLUMN "show_args" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "approval" ADD COLUMN "edits" jsonb;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_edits_ck" CHECK ("approval"."edits" is null or "approval"."status" = 'approved');