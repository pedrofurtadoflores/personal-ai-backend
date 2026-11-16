CREATE TABLE "diary_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"learnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"mood" integer,
	"summary_edited" boolean DEFAULT false NOT NULL,
	"condensed_at" timestamp with time zone,
	"embedding" vector(1536),
	"embedding_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diary_days_date_unique" UNIQUE("date")
);
--> statement-breakpoint
CREATE TABLE "diary_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"concluded_at" timestamp with time zone,
	"memorized_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "diary_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "diary_turns" ADD CONSTRAINT "diary_turns_entry_id_diary_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."diary_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "diary_entries_date_index" ON "diary_entries" USING btree ("date");--> statement-breakpoint
CREATE INDEX "diary_turns_entry_id_created_at_index" ON "diary_turns" USING btree ("entry_id","created_at");