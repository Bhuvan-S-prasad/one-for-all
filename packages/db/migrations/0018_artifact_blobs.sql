-- Artifacts over 1 MB keep their bytes in the object store (ADR-0047): the row
-- holds either the content or the blob key, never both. No RLS change: same table.
ALTER TABLE "artifact" DROP CONSTRAINT "artifact_size_ck";--> statement-breakpoint
ALTER TABLE "artifact" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact" ADD COLUMN "blob_key" text;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_bytes_ck" CHECK (("artifact"."content" is null) <> ("artifact"."blob_key" is null));--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_size_ck" CHECK ("artifact"."size" >= 0 and ("artifact"."blob_key" is not null or "artifact"."size" <= 10485760));