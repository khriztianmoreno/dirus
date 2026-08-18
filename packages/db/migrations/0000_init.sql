CREATE TABLE "broker_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"role" text DEFAULT 'agent' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broker_users_broker_id_phone_unique" UNIQUE("broker_id","phone")
);
--> statement-breakpoint
CREATE TABLE "brokers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"wa_phone_number_id" text NOT NULL,
	"waba_id" text NOT NULL,
	"plan" text DEFAULT 'pilot' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"chatwoot_account_id" integer,
	CONSTRAINT "brokers_wa_phone_number_id_unique" UNIQUE("wa_phone_number_id"),
	CONSTRAINT "brokers_chatwoot_account_id_unique" UNIQUE("chatwoot_account_id")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"full_name" text,
	"doc_type" text,
	"doc_number" text,
	"consent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"chatwoot_contact_id" integer,
	CONSTRAINT "contacts_broker_id_phone_unique" UNIQUE("broker_id","phone")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_id" uuid NOT NULL,
	"contact_id" uuid,
	"broker_user_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'bot' NOT NULL,
	"escalation_reason" text,
	"window_expires_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"chatwoot_conversation_id" integer
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_id" uuid NOT NULL,
	"policy_id" uuid,
	"contact_id" uuid,
	"message_id" uuid,
	"r2_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"doc_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_id" uuid NOT NULL,
	"document_id" uuid,
	"message_id" uuid,
	"model" text NOT NULL,
	"output" jsonb NOT NULL,
	"confidence" jsonb NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"corrected_output" jsonb,
	"corrected_by" uuid,
	"langfuse_trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"sender" text NOT NULL,
	"type" text NOT NULL,
	"body" text,
	"media_r2_key" text,
	"wa_message_id" text,
	"template_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"chatwoot_message_id" integer,
	CONSTRAINT "messages_wa_message_id_unique" UNIQUE("wa_message_id")
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"insurer" text NOT NULL,
	"line" text NOT NULL,
	"policy_number" text,
	"plate" text,
	"premium_amount" numeric(14, 2),
	"currency" text DEFAULT 'COP' NOT NULL,
	"commission_pct" numeric(5, 2),
	"start_date" date,
	"end_date" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "renewals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"conversation_id" uuid,
	"due_date" date NOT NULL,
	"workflow_run_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"payment_link" text,
	"paid_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "renewals_policy_id_due_date_unique" UNIQUE("policy_id","due_date")
);
--> statement-breakpoint
ALTER TABLE "broker_users" ADD CONSTRAINT "broker_users_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_broker_user_id_broker_users_id_fk" FOREIGN KEY ("broker_user_id") REFERENCES "public"."broker_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_corrected_by_broker_users_id_fk" FOREIGN KEY ("corrected_by") REFERENCES "public"."broker_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewals" ADD CONSTRAINT "renewals_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewals" ADD CONSTRAINT "renewals_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewals" ADD CONSTRAINT "renewals_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extractions_broker_id_needs_review_index" ON "extractions" USING btree ("broker_id","needs_review") WHERE "extractions"."needs_review" = true;--> statement-breakpoint
CREATE INDEX "messages_conversation_id_created_at_index" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "policies_broker_id_end_date_index" ON "policies" USING btree ("broker_id","end_date") WHERE "policies"."status" = 'active';