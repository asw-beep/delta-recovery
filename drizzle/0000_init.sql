CREATE TYPE "public"."action_type" AS ENUM('ISSUE_RECOVERY_LINK', 'NUDGE_SMS', 'NUDGE_EMAIL', 'DEFER', 'WITHDRAW', 'ESCALATE_HUMAN', 'STOP');--> statement-breakpoint
CREATE TYPE "public"."attempt_status" AS ENUM('pending', 'succeeded', 'failed', 'skipped_duplicate');--> statement-breakpoint
CREATE TYPE "public"."detected_via" AS ENUM('webhook', 'reconciliation');--> statement-breakpoint
CREATE TYPE "public"."exec_mode" AS ENUM('live', 'sim');--> statement-breakpoint
CREATE TYPE "public"."outcome_result" AS ENUM('pending', 'recovered', 'partially_recovered', 'expired', 'no_response');--> statement-breakpoint
CREATE TYPE "public"."policy_verdict" AS ENUM('ALLOW', 'DELAY', 'ESCALATE', 'STOP');--> statement-breakpoint
CREATE TYPE "public"."risk_class" AS ENUM('failed_payment', 'abandoned_checkout', 'overdue_receivable');--> statement-breakpoint
CREATE TYPE "public"."risk_state" AS ENUM('open', 'in_progress', 'recovered', 'closed');--> statement-breakpoint
CREATE TYPE "public"."taxonomy_class" AS ENUM('TRANSIENT', 'CUSTOMER_FIXABLE', 'INSTRUMENT_DEAD', 'DO_NOT_TOUCH', 'OPAQUE');--> statement-breakpoint
CREATE TABLE "action_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"attempt_no" integer DEFAULT 1 NOT NULL,
	"action" "action_type" NOT NULL,
	"mode" "exec_mode" NOT NULL,
	"status" "attempt_status" DEFAULT 'pending' NOT NULL,
	"razorpay_entity_id" text,
	"short_url" text,
	"reference_id" text,
	"request" jsonb,
	"response" jsonb,
	"http_status" integer,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"decision_id" uuid,
	"channel" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"razorpay_customer_id" text,
	"name" text,
	"email" text,
	"contact" text,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"lifetime_value_paise" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone,
	"payday_dom" integer,
	"opted_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"risk_item_id" uuid NOT NULL,
	"score_id" uuid,
	"diagnosis_id" uuid,
	"proposed_action" "action_type" NOT NULL,
	"expected_value_paise" integer NOT NULL,
	"action_cost_paise" integer NOT NULL,
	"llm_proposed_action" "action_type",
	"llm_rationale" text,
	"verdict" "policy_verdict" NOT NULL,
	"verdict_reasons" text[] NOT NULL,
	"policy_version" text NOT NULL,
	"deferred_until" timestamp with time zone,
	"batch_id" uuid,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diagnoses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"risk_item_id" uuid NOT NULL,
	"taxonomy_class" "taxonomy_class" NOT NULL,
	"deterministic_reason" text NOT NULL,
	"llm_narrative" text,
	"llm_model" text,
	"llm_cache_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "downtimes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"razorpay_downtime_id" text NOT NULL,
	"method" text NOT NULL,
	"instrument" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"severity" text,
	"begin" timestamp with time zone,
	"end" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"risk_item_id" uuid NOT NULL,
	"decision_id" uuid,
	"reason" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"was_necessary" boolean
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"customer_id" uuid,
	"razorpay_invoice_id" text NOT NULL,
	"status" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"amount_paid_paise" integer DEFAULT 0 NOT NULL,
	"amount_due_paise" integer DEFAULT 0 NOT NULL,
	"short_url" text,
	"expire_by" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"razorpay_key_id" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"customer_id" uuid,
	"razorpay_order_id" text NOT NULL,
	"status" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"amount_paid_paise" integer DEFAULT 0 NOT NULL,
	"amount_due_paise" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"receipt" text,
	"notes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at_rzp" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"risk_item_id" uuid NOT NULL,
	"result" "outcome_result" DEFAULT 'pending' NOT NULL,
	"recovered_amount_paise" integer DEFAULT 0 NOT NULL,
	"recovered_at" timestamp with time zone,
	"attribution_source" text,
	"verifying_event_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"customer_id" uuid,
	"order_id" uuid,
	"razorpay_payment_id" text NOT NULL,
	"razorpay_order_id" text,
	"status" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"method" text,
	"bank" text,
	"wallet" text,
	"vpa" text,
	"error_code" text,
	"error_description" text,
	"error_source" text,
	"error_step" text,
	"error_reason" text,
	"created_at_rzp" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"customer_id" uuid,
	"class" "risk_class" NOT NULL,
	"state" "risk_state" DEFAULT 'open' NOT NULL,
	"source_entity_id" text NOT NULL,
	"source_entity_type" text NOT NULL,
	"amount_at_risk_paise" integer NOT NULL,
	"detected_via" "detected_via" NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_reason" text
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"risk_item_id" uuid NOT NULL,
	"p_recover_do_nothing" real NOT NULL,
	"p_recover_contact" real NOT NULL,
	"uplift" real NOT NULL,
	"model_version" text NOT NULL,
	"features" jsonb NOT NULL,
	"contributions" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"razorpay_event_id" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"signature_valid" boolean NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text
);
--> statement-breakpoint
ALTER TABLE "action_attempts" ADD CONSTRAINT "action_attempts_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_risk_item_id_risk_items_id_fk" FOREIGN KEY ("risk_item_id") REFERENCES "public"."risk_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_score_id_scores_id_fk" FOREIGN KEY ("score_id") REFERENCES "public"."scores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_diagnosis_id_diagnoses_id_fk" FOREIGN KEY ("diagnosis_id") REFERENCES "public"."diagnoses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_risk_item_id_risk_items_id_fk" FOREIGN KEY ("risk_item_id") REFERENCES "public"."risk_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_risk_item_id_risk_items_id_fk" FOREIGN KEY ("risk_item_id") REFERENCES "public"."risk_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_risk_item_id_risk_items_id_fk" FOREIGN KEY ("risk_item_id") REFERENCES "public"."risk_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_verifying_event_id_webhook_events_id_fk" FOREIGN KEY ("verifying_event_id") REFERENCES "public"."webhook_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_items" ADD CONSTRAINT "risk_items_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_items" ADD CONSTRAINT "risk_items_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_risk_item_id_risk_items_id_fk" FOREIGN KEY ("risk_item_id") REFERENCES "public"."risk_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_attempts_idempotency_uq" ON "action_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "action_attempts_entity_idx" ON "action_attempts" USING btree ("razorpay_entity_id");--> statement-breakpoint
CREATE INDEX "contacts_customer_window_idx" ON "contacts" USING btree ("customer_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_merchant_external_uq" ON "customers" USING btree ("merchant_id","external_id");--> statement-breakpoint
CREATE INDEX "decisions_risk_item_idx" ON "decisions" USING btree ("risk_item_id");--> statement-breakpoint
CREATE INDEX "decisions_batch_idx" ON "decisions" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "downtimes_rzp_id_uq" ON "downtimes" USING btree ("razorpay_downtime_id");--> statement-breakpoint
CREATE INDEX "downtimes_open_idx" ON "downtimes" USING btree ("method") WHERE "downtimes"."end" is null;--> statement-breakpoint
CREATE INDEX "escalations_open_idx" ON "escalations" USING btree ("assigned_at") WHERE "escalations"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_rzp_id_uq" ON "invoices" USING btree ("razorpay_invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_rzp_id_uq" ON "orders" USING btree ("razorpay_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outcomes_decision_uq" ON "outcomes" USING btree ("decision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_rzp_id_uq" ON "payments" USING btree ("razorpay_payment_id");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("merchant_id","status","created_at_rzp");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_items_open_source_uq" ON "risk_items" USING btree ("source_entity_id") WHERE "risk_items"."state" = 'open';--> statement-breakpoint
CREATE INDEX "risk_items_queue_idx" ON "risk_items" USING btree ("merchant_id","state","detected_at");--> statement-breakpoint
CREATE INDEX "scores_risk_item_idx" ON "scores" USING btree ("risk_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_event_id_uq" ON "webhook_events" USING btree ("razorpay_event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "webhook_events" USING btree ("received_at") WHERE "webhook_events"."processed_at" is null;