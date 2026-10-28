CREATE TABLE "fin_debt_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"debt_id" uuid NOT NULL,
	"transaction_id" uuid,
	"date" date NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_debts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"amount" bigint NOT NULL,
	"started_on" date NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "fin_debt_payments" ADD CONSTRAINT "fin_debt_payments_debt_id_fin_debts_id_fk" FOREIGN KEY ("debt_id") REFERENCES "public"."fin_debts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_debt_payments" ADD CONSTRAINT "fin_debt_payments_transaction_id_fin_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."fin_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fin_debt_payments_debt_id_index" ON "fin_debt_payments" USING btree ("debt_id");--> statement-breakpoint
CREATE INDEX "fin_debts_archived_at_index" ON "fin_debts" USING btree ("archived_at");