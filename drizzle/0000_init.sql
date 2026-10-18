-- pgvector precisa existir antes das colunas vector(1536).
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."author" AS ENUM('ai', 'user');--> statement-breakpoint
CREATE TYPE "public"."file_status" AS ENUM('pending', 'uploaded', 'processing', 'ready', 'error');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant', 'system', 'tool');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('streaming', 'completed', 'stopped', 'error');--> statement-breakpoint
CREATE TYPE "public"."sinapse_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."suggestion_kind" AS ENUM('create', 'update', 'merge', 'link');--> statement-breakpoint
CREATE TYPE "public"."suggestion_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."tool_call_status" AS ENUM('pending', 'completed', 'error');--> statement-breakpoint
CREATE TYPE "public"."usage_source" AS ENUM('chat', 'background', 'embedding', 'image', 'transcription', 'speech', 'realtime');--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text,
	"folder_id" uuid,
	"model" text,
	"system_prompt" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"anonymous" boolean DEFAULT false NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"current_leaf_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "file_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"text" text NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding" vector(1536) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"r2_key" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"extracted_text" text,
	"status" "file_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "files_r2Key_unique" UNIQUE("r2_key")
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generated_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid,
	"file_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_embeddings" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_files" (
	"message_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	CONSTRAINT "message_files_message_id_file_id_pk" PRIMARY KEY("message_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"parent_id" uuid,
	"role" "message_role" NOT NULL,
	"content" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_text" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('portuguese', coalesce(content_text, ''))) STORED,
	"model" text,
	"params" jsonb,
	"status" "message_status" DEFAULT 'completed' NOT NULL,
	"error" text,
	"openai_response_id" text,
	"tokens_in" integer,
	"tokens_cached" integer,
	"tokens_out" integer,
	"tokens_reasoning" integer,
	"cost_usd" numeric(14, 8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "model_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"input_price" numeric(14, 8),
	"cached_input_price" numeric(14, 8),
	"output_price" numeric(14, 8),
	"context_window" integer,
	"max_output_tokens" integer,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recommendation" text,
	"example" text,
	"has_metadata" boolean DEFAULT false NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"openai_created_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sinapse_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sinapse_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"text" text NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding" vector(1536) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sinapse_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sinapse_a" uuid NOT NULL,
	"sinapse_b" uuid NOT NULL,
	"reason" text,
	"created_by" "author" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sinapse_links_ordered_pair" CHECK ("sinapse_links"."sinapse_a" < "sinapse_links"."sinapse_b")
);
--> statement-breakpoint
CREATE TABLE "sinapse_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sinapse_id" uuid NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"file_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sinapse_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sinapse_id" uuid,
	"kind" "suggestion_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"reason" text,
	"status" "suggestion_status" DEFAULT 'pending' NOT NULL,
	"source_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sinapse_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sinapse_id" uuid NOT NULL,
	"title" text NOT NULL,
	"emoji" text,
	"summary" text NOT NULL,
	"content" text NOT NULL,
	"tags" text[] NOT NULL,
	"author" "author" NOT NULL,
	"reason" text,
	"source_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sinapses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"emoji" text,
	"summary" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "sinapse_status" DEFAULT 'active' NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_by" "author" NOT NULL,
	"summary_embedding" vector(1536),
	"summary_embedding_model" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('portuguese', title), 'A') || setweight(to_tsvector('portuguese', summary), 'B') || setweight(to_tsvector('portuguese', content), 'C')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"call_id" text,
	"name" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"status" "tool_call_status" DEFAULT 'completed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "usage_source" NOT NULL,
	"model" text NOT NULL,
	"message_id" uuid,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_cached" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"tokens_reasoning" integer DEFAULT 0 NOT NULL,
	"units" jsonb,
	"cost_usd" numeric(14, 8) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_current_leaf_message_id_messages_id_fk" FOREIGN KEY ("current_leaf_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_images" ADD CONSTRAINT "generated_images_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_images" ADD CONSTRAINT "generated_images_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_embeddings" ADD CONSTRAINT "message_embeddings_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_files" ADD CONSTRAINT "message_files_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_files" ADD CONSTRAINT "message_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_parent_id_messages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sinapse_chunks" ADD CONSTRAINT "sinapse_chunks_sinapse_id_sinapses_id_fk" FOREIGN KEY ("sinapse_id") REFERENCES "public"."sinapses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sinapse_links" ADD CONSTRAINT "sinapse_links_sinapse_a_sinapses_id_fk" FOREIGN KEY ("sinapse_a") REFERENCES "public"."sinapses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sinapse_links" ADD CONSTRAINT "sinapse_links_sinapse_b_sinapses_id_fk" FOREIGN KEY ("sinapse_b") REFERENCES "public"."sinapses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sinapse_sources" ADD CONSTRAINT "sinapse_sources_sinapse_id_sinapses_id_fk" FOREIGN KEY ("sinapse_id") REFERENCES "public"."sinapses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sinapse_sources" ADD CONSTRAINT "sinapse_sources_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sinapse_sources" ADD CONSTRAINT "sinapse_sources_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sinapse_sources" ADD CONSTRAINT "sinapse_sources_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sinapse_suggestions" ADD CONSTRAINT "sinapse_suggestions_sinapse_id_sinapses_id_fk" FOREIGN KEY ("sinapse_id") REFERENCES "public"."sinapses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sinapse_suggestions" ADD CONSTRAINT "sinapse_suggestions_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sinapse_versions" ADD CONSTRAINT "sinapse_versions_sinapse_id_sinapses_id_fk" FOREIGN KEY ("sinapse_id") REFERENCES "public"."sinapses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sinapse_versions" ADD CONSTRAINT "sinapse_versions_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_updated_at_index" ON "conversations" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "conversations_folder_id_index" ON "conversations" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "file_chunks_file_id_index" ON "file_chunks" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "file_chunks_embedding_index" ON "file_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "message_embeddings_embedding_index" ON "message_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "messages_conversation_id_created_at_index" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_parent_id_index" ON "messages" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "messages_search_vector_index" ON "messages" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "sinapse_chunks_sinapse_id_index" ON "sinapse_chunks" USING btree ("sinapse_id");--> statement-breakpoint
CREATE INDEX "sinapse_chunks_embedding_index" ON "sinapse_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "sinapse_links_sinapse_a_sinapse_b_index" ON "sinapse_links" USING btree ("sinapse_a","sinapse_b");--> statement-breakpoint
CREATE INDEX "sinapse_sources_sinapse_id_index" ON "sinapse_sources" USING btree ("sinapse_id");--> statement-breakpoint
CREATE INDEX "sinapse_suggestions_status_index" ON "sinapse_suggestions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sinapse_versions_sinapse_id_created_at_index" ON "sinapse_versions" USING btree ("sinapse_id","created_at");--> statement-breakpoint
CREATE INDEX "sinapses_summary_embedding_index" ON "sinapses" USING hnsw ("summary_embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "sinapses_tags_index" ON "sinapses" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "sinapses_search_vector_index" ON "sinapses" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "tool_calls_message_id_index" ON "tool_calls" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "usage_events_created_at_index" ON "usage_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "usage_events_model_index" ON "usage_events" USING btree ("model");