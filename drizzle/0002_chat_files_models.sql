CREATE TYPE "public"."file_origin" AS ENUM('upload', 'generated');--> statement-breakpoint
CREATE TYPE "public"."model_kind" AS ENUM('chat', 'image', 'embedding', 'transcription', 'speech', 'realtime', 'other');--> statement-breakpoint
CREATE TABLE "backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"r2_key" text NOT NULL,
	"size" bigint,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "backups_r2Key_unique" UNIQUE("r2_key")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_consolidated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "origin" "file_origin" DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "kind" "model_kind" DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "is_snapshot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "extra_prices" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_created_at_index" ON "files" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "files_conversation_id_index" ON "files" USING btree ("conversation_id");