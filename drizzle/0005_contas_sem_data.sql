CREATE TABLE "fin_pending" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"estimate" bigint,
	"category_id" uuid,
	"notes" text,
	"transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "fin_pending" ADD CONSTRAINT "fin_pending_category_id_fin_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."fin_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_pending" ADD CONSTRAINT "fin_pending_transaction_id_fin_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."fin_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fin_pending_closed_at_index" ON "fin_pending" USING btree ("closed_at");