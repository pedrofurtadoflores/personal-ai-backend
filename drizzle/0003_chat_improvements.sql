ALTER TYPE "public"."message_status" ADD VALUE 'incomplete';--> statement-breakpoint
CREATE TABLE "conversation_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"up_to_message_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"messages_count" integer NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "instructions" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "sinapse_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "rating" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "feedback_note" text;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_up_to_message_id_messages_id_fk" FOREIGN KEY ("up_to_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_summaries_conversation_id_created_at_index" ON "conversation_summaries" USING btree ("conversation_id","created_at");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_folder_id_index" ON "files" USING btree ("folder_id");