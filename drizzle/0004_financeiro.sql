CREATE TYPE "public"."fin_account_type" AS ENUM('checking', 'credit_card', 'cash', 'other');--> statement-breakpoint
CREATE TYPE "public"."fin_asset_type" AS ENUM('vehicle', 'real_estate', 'investment', 'other');--> statement-breakpoint
CREATE TYPE "public"."fin_category_kind" AS ENUM('income', 'expense');--> statement-breakpoint
CREATE TYPE "public"."fin_category_source" AS ENUM('user', 'rule', 'ai');--> statement-breakpoint
CREATE TYPE "public"."fin_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."fin_import_status" AS ENUM('done', 'failed', 'undone');--> statement-breakpoint
CREATE TYPE "public"."fin_institution" AS ENUM('nubank', 'bradesco', 'other');--> statement-breakpoint
CREATE TYPE "public"."fin_nature" AS ENUM('fixed', 'variable');--> statement-breakpoint
CREATE TYPE "public"."fin_rule_action" AS ENUM('categorize', 'ask', 'transfer');--> statement-breakpoint
CREATE TYPE "public"."fin_rule_match" AS ENUM('contains', 'equals', 'regex');--> statement-breakpoint
CREATE TYPE "public"."fin_suggestion_status" AS ENUM('pending', 'accepted', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."fin_tx_class" AS ENUM('normal', 'transfer', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."fin_tx_status" AS ENUM('planned', 'review', 'auto', 'confirmed');--> statement-breakpoint
CREATE TABLE "fin_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "fin_account_type" NOT NULL,
	"institution" "fin_institution" DEFAULT 'other' NOT NULL,
	"holder" text,
	"closing_day" integer,
	"due_day" integer,
	"opening_balance" bigint DEFAULT 0 NOT NULL,
	"opening_date" date,
	"bank_balance" bigint,
	"bank_balance_date" date,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_asset_valuations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"date" date NOT NULL,
	"value" bigint NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "fin_asset_type" DEFAULT 'other' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "fin_category_kind" NOT NULL,
	"nature" "fin_nature" DEFAULT 'variable' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"before" jsonb,
	"author" "author" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"format" text NOT NULL,
	"invoice_id" uuid,
	"period_start" date,
	"period_end" date,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"balance_check" jsonb,
	"status" "fin_import_status" DEFAULT 'done' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fin_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"reference_month" date NOT NULL,
	"closing_date" date NOT NULL,
	"best_purchase_date" date NOT NULL,
	"due_date" date NOT NULL,
	"statement_total" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_recurring" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"direction" "fin_direction" NOT NULL,
	"category_id" uuid,
	"account_id" uuid NOT NULL,
	"expected_amount" bigint DEFAULT 0 NOT NULL,
	"tolerance_pct" integer DEFAULT 15 NOT NULL,
	"day_of_month" integer NOT NULL,
	"match_pattern" text,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_rule_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pattern" text NOT NULL,
	"category_id" uuid NOT NULL,
	"evidence" integer DEFAULT 0 NOT NULL,
	"status" "fin_suggestion_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_type" "fin_rule_match" DEFAULT 'contains' NOT NULL,
	"pattern" text NOT NULL,
	"account_id" uuid,
	"min_amount" bigint,
	"max_amount" bigint,
	"sign" integer,
	"action" "fin_rule_action" DEFAULT 'categorize' NOT NULL,
	"category_id" uuid,
	"rename_to" text,
	"nature" "fin_nature",
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"created_by" "author" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_splits" (
	"transaction_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"category_id" uuid,
	"amount" bigint NOT NULL,
	CONSTRAINT "fin_splits_transaction_id_idx_pk" PRIMARY KEY("transaction_id","idx")
);
--> statement-breakpoint
CREATE TABLE "fin_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"invoice_id" uuid,
	"date" date NOT NULL,
	"amount" bigint NOT NULL,
	"class" "fin_tx_class" DEFAULT 'normal' NOT NULL,
	"description" text NOT NULL,
	"original_description" text,
	"merchant" text,
	"category_id" uuid,
	"nature" "fin_nature",
	"status" "fin_tx_status" DEFAULT 'confirmed' NOT NULL,
	"category_source" "fin_category_source",
	"rule_id" uuid,
	"ai_confidence" real,
	"ai_question" text,
	"ai_suggestions" uuid[],
	"ai_tried_at" timestamp with time zone,
	"transfer_group_id" uuid,
	"installment_group" text,
	"installment_number" integer,
	"installment_total" integer,
	"recurring_id" uuid,
	"recurring_period" date,
	"deferred_from" date,
	"deferral_reason" text,
	"manual" boolean DEFAULT false NOT NULL,
	"import_batch_id" uuid,
	"external_id" text,
	"fingerprint" text,
	"notes" text,
	"created_by" "author" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "fin_asset_valuations" ADD CONSTRAINT "fin_asset_valuations_asset_id_fin_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."fin_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_import_batches" ADD CONSTRAINT "fin_import_batches_account_id_fin_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."fin_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_import_batches" ADD CONSTRAINT "fin_import_batches_invoice_id_fin_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."fin_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_invoices" ADD CONSTRAINT "fin_invoices_account_id_fin_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."fin_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_recurring" ADD CONSTRAINT "fin_recurring_category_id_fin_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."fin_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_recurring" ADD CONSTRAINT "fin_recurring_account_id_fin_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."fin_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_rule_suggestions" ADD CONSTRAINT "fin_rule_suggestions_category_id_fin_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."fin_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_rules" ADD CONSTRAINT "fin_rules_account_id_fin_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."fin_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_rules" ADD CONSTRAINT "fin_rules_category_id_fin_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."fin_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_splits" ADD CONSTRAINT "fin_splits_transaction_id_fin_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."fin_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_splits" ADD CONSTRAINT "fin_splits_category_id_fin_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."fin_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_transactions" ADD CONSTRAINT "fin_transactions_account_id_fin_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."fin_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_transactions" ADD CONSTRAINT "fin_transactions_invoice_id_fin_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."fin_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_transactions" ADD CONSTRAINT "fin_transactions_category_id_fin_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."fin_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_transactions" ADD CONSTRAINT "fin_transactions_rule_id_fin_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."fin_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_transactions" ADD CONSTRAINT "fin_transactions_recurring_id_fin_recurring_id_fk" FOREIGN KEY ("recurring_id") REFERENCES "public"."fin_recurring"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_transactions" ADD CONSTRAINT "fin_transactions_import_batch_id_fin_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."fin_import_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fin_asset_valuations_asset_id_date_index" ON "fin_asset_valuations" USING btree ("asset_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "fin_categories_name_unique" ON "fin_categories" USING btree (lower("name")) WHERE "fin_categories"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "fin_changes_operation_id_index" ON "fin_changes" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "fin_import_batches_account_id_created_at_index" ON "fin_import_batches" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fin_invoices_account_id_reference_month_index" ON "fin_invoices" USING btree ("account_id","reference_month");--> statement-breakpoint
CREATE UNIQUE INDEX "fin_rule_suggestions_pattern_index" ON "fin_rule_suggestions" USING btree ("pattern");--> statement-breakpoint
CREATE INDEX "fin_transactions_date_index" ON "fin_transactions" USING btree ("date");--> statement-breakpoint
CREATE INDEX "fin_transactions_account_id_date_index" ON "fin_transactions" USING btree ("account_id","date");--> statement-breakpoint
CREATE INDEX "fin_transactions_category_id_date_index" ON "fin_transactions" USING btree ("category_id","date");--> statement-breakpoint
CREATE INDEX "fin_transactions_merchant_index" ON "fin_transactions" USING btree ("merchant");--> statement-breakpoint
CREATE INDEX "fin_transactions_status_index" ON "fin_transactions" USING btree ("status") WHERE "fin_transactions"."status" = 'review';--> statement-breakpoint
CREATE UNIQUE INDEX "fin_transactions_account_id_fingerprint_index" ON "fin_transactions" USING btree ("account_id","fingerprint") WHERE "fin_transactions"."fingerprint" is not null and "fin_transactions"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "fin_transactions_recurring_id_recurring_period_index" ON "fin_transactions" USING btree ("recurring_id","recurring_period") WHERE "fin_transactions"."recurring_id" is not null and "fin_transactions"."deleted_at" is null;