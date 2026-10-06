ALTER TABLE "approval" ADD COLUMN "site" text;--> statement-breakpoint
ALTER TABLE "approval" ADD COLUMN "scope" text DEFAULT 'once' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_scope_ck" CHECK ("approval"."scope" = 'once' or ("approval"."scope" = 'site' and "approval"."site" is not null));