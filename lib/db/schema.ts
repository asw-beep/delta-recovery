import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Delta — data model.
 *
 * Money is stored in PAISE as integers everywhere. Never floats, never rupees.
 *
 * Three constraints carry the safety argument and are enforced by the database
 * rather than by application code (DECISIONS.md §8):
 *   1. webhookEvents.razorpayEventId       UNIQUE  — duplicate delivery is a no-op
 *   2. actionAttempts.idempotencyKey       UNIQUE  — no double execution
 *   3. riskItems partial unique WHERE open — webhook + reconciliation converge
 */

// ─── Enums ──────────────────────────────────────────────────────────────────

export const riskClass = pgEnum("risk_class", [
  "failed_payment",
  "abandoned_checkout",
  "overdue_receivable",
]);

export const riskState = pgEnum("risk_state", [
  "open", // detected, not yet acted on
  "in_progress", // an action has been executed, awaiting outcome
  "recovered", // money came back
  "closed", // terminal without recovery (expired, stopped, escalated-and-resolved)
]);

export const detectedVia = pgEnum("detected_via", ["webhook", "reconciliation"]);

/** Failure taxonomy. Mapping is deterministic; unmapped reasons raise. DECISIONS.md §3. */
export const taxonomyClass = pgEnum("taxonomy_class", [
  "TRANSIENT",
  "CUSTOMER_FIXABLE",
  "INSTRUMENT_DEAD",
  "DO_NOT_TOUCH",
  "OPAQUE",
]);

export const actionType = pgEnum("action_type", [
  "ISSUE_RECOVERY_LINK",
  "NUDGE_SMS",
  "NUDGE_EMAIL",
  "DEFER",
  "WITHDRAW",
  "ESCALATE_HUMAN",
  "STOP",
]);

export const policyVerdict = pgEnum("policy_verdict", [
  "ALLOW",
  "DELAY",
  "ESCALATE",
  "STOP",
]);

/** Whether an action hit the real Razorpay API or the simulator. Never hidden from the UI. */
export const execMode = pgEnum("exec_mode", ["live", "sim"]);

export const attemptStatus = pgEnum("attempt_status", [
  "pending", // idempotency row written, call not yet made
  "succeeded",
  "failed",
  "skipped_duplicate",
]);

export const outcomeResult = pgEnum("outcome_result", [
  "pending",
  "recovered",
  "partially_recovered",
  "expired",
  "no_response",
]);

// ─── Core entities ──────────────────────────────────────────────────────────

export const merchants = pgTable("merchants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  razorpayKeyId: text("razorpay_key_id").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull().references(() => merchants.id),
    externalId: text("external_id").notNull(), // our stable customer key
    razorpayCustomerId: text("razorpay_customer_id"),
    name: text("name"),
    email: text("email"),
    contact: text("contact"),

    // Recovery-relevant history, maintained by the normaliser.
    successCount: integer("success_count").default(0).notNull(),
    failureCount: integer("failure_count").default(0).notNull(),
    lifetimeValuePaise: integer("lifetime_value_paise").default(0).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),

    /** Payday cycle day-of-month, used by the insufficient_funds timing feature. */
    paydayDom: integer("payday_dom"),

    /** Hard stop. Set means no automated contact, ever. */
    optedOutAt: timestamp("opted_out_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("customers_merchant_external_uq").on(t.merchantId, t.externalId)],
);

// ─── Ingest ─────────────────────────────────────────────────────────────────

/**
 * Raw, immutable webhook log. Written BEFORE any processing so a crash mid-flight
 * loses nothing and Razorpay's 5s window is never at risk.
 */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Razorpay's x-razorpay-event-id header. The dedupe key. */
    razorpayEventId: text("razorpay_event_id").notNull(),
    event: text("event").notNull(), // e.g. "payment.failed"
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    signatureValid: boolean("signature_valid").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    processingError: text("processing_error"),
  },
  (t) => [
    // CONSTRAINT 1 — duplicate delivery is a no-op at the database level.
    uniqueIndex("webhook_events_event_id_uq").on(t.razorpayEventId),
    index("webhook_events_unprocessed_idx")
      .on(t.receivedAt)
      .where(sql`${t.processedAt} is null`),
  ],
);

// ─── Normalised Razorpay entities ───────────────────────────────────────────

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull().references(() => merchants.id),
    customerId: uuid("customer_id").references(() => customers.id),
    razorpayOrderId: text("razorpay_order_id").notNull(),
    status: text("status").notNull(), // created | attempted | paid
    amountPaise: integer("amount_paise").notNull(),
    amountPaidPaise: integer("amount_paid_paise").default(0).notNull(),
    amountDuePaise: integer("amount_due_paise").default(0).notNull(),
    attempts: integer("attempts").default(0).notNull(),
    receipt: text("receipt"),
    notes: jsonb("notes").$type<Record<string, unknown>>().default({}).notNull(),
    createdAtRzp: timestamp("created_at_rzp", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("orders_rzp_id_uq").on(t.razorpayOrderId)],
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull().references(() => merchants.id),
    customerId: uuid("customer_id").references(() => customers.id),
    orderId: uuid("order_id").references(() => orders.id),
    razorpayPaymentId: text("razorpay_payment_id").notNull(),
    razorpayOrderId: text("razorpay_order_id"),

    status: text("status").notNull(), // created|authorized|captured|refunded|failed
    amountPaise: integer("amount_paise").notNull(),
    method: text("method"), // card | netbanking | upi | wallet
    bank: text("bank"),
    wallet: text("wallet"),
    vpa: text("vpa"),

    // Diagnosis inputs — the richest signal we get. DECISIONS.md §3.
    errorCode: text("error_code"),
    errorDescription: text("error_description"),
    errorSource: text("error_source"),
    errorStep: text("error_step"),
    errorReason: text("error_reason"),

    createdAtRzp: timestamp("created_at_rzp", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("payments_rzp_id_uq").on(t.razorpayPaymentId),
    index("payments_status_idx").on(t.merchantId, t.status, t.createdAtRzp),
  ],
);

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull().references(() => merchants.id),
    customerId: uuid("customer_id").references(() => customers.id),
    razorpayInvoiceId: text("razorpay_invoice_id").notNull(),
    status: text("status").notNull(), // draft|issued|partially_paid|paid|cancelled|expired|deleted
    amountPaise: integer("amount_paise").notNull(),
    amountPaidPaise: integer("amount_paid_paise").default(0).notNull(),
    amountDuePaise: integer("amount_due_paise").default(0).notNull(),
    shortUrl: text("short_url"),
    expireBy: timestamp("expire_by", { withTimezone: true }),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("invoices_rzp_id_uq").on(t.razorpayInvoiceId)],
);

/**
 * Instrument health from the Downtime API and downtime webhooks.
 * Drives the deferral rule: never send a recovery link into an open outage.
 */
export const downtimes = pgTable(
  "downtimes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    razorpayDowntimeId: text("razorpay_downtime_id").notNull(),
    method: text("method").notNull(), // card | netbanking | upi
    instrument: jsonb("instrument").$type<Record<string, unknown>>().default({}).notNull(),
    status: text("status").notNull(), // started | resolved
    severity: text("severity"),
    begin: timestamp("begin", { withTimezone: true }),
    end: timestamp("end", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("downtimes_rzp_id_uq").on(t.razorpayDowntimeId),
    index("downtimes_open_idx").on(t.method).where(sql`${t.end} is null`),
  ],
);

// ─── The recovery loop ──────────────────────────────────────────────────────

/** One unit of money at risk. The spine of the product. */
export const riskItems = pgTable(
  "risk_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull().references(() => merchants.id),
    customerId: uuid("customer_id").references(() => customers.id),

    class: riskClass("class").notNull(),
    state: riskState("state").default("open").notNull(),

    /** The Razorpay id this risk derives from — pay_… / order_… / inv_… */
    sourceEntityId: text("source_entity_id").notNull(),
    sourceEntityType: text("source_entity_type").notNull(), // payment | order | invoice

    amountAtRiskPaise: integer("amount_at_risk_paise").notNull(),

    detectedVia: detectedVia("detected_via").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedReason: text("closed_reason"),
  },
  (t) => [
    // CONSTRAINT 3 — the webhook path and the reconciliation path cannot both
    // open a risk item for the same entity.
    uniqueIndex("risk_items_open_source_uq")
      .on(t.sourceEntityId)
      .where(sql`${t.state} = 'open'`),
    index("risk_items_queue_idx").on(t.merchantId, t.state, t.detectedAt),
  ],
);

export const diagnoses = pgTable("diagnoses", {
  id: uuid("id").primaryKey().defaultRandom(),
  riskItemId: uuid("risk_item_id").notNull().references(() => riskItems.id),

  /** Deterministic. Never produced by a model. */
  taxonomyClass: taxonomyClass("taxonomy_class").notNull(),
  deterministicReason: text("deterministic_reason").notNull(),

  /** Generated prose. Null when the LLM was unavailable — the loop runs regardless. */
  llmNarrative: text("llm_narrative"),
  llmModel: text("llm_model"),
  /** Set when the narrative came from the class-level cache rather than a fresh call. */
  llmCacheKey: text("llm_cache_key"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Model output. Features are stored so any prediction can be reproduced exactly. */
export const scores = pgTable(
  "scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    riskItemId: uuid("risk_item_id").notNull().references(() => riskItems.id),

    pRecoverDoNothing: real("p_recover_do_nothing").notNull(),
    pRecoverContact: real("p_recover_contact").notNull(),
    uplift: real("uplift").notNull(),

    modelVersion: text("model_version").notNull(),
    features: jsonb("features").$type<Record<string, number | string | null>>().notNull(),
    /** Per-feature contributions, for the audit view. */
    contributions: jsonb("contributions").$type<Record<string, number>>(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("scores_risk_item_idx").on(t.riskItemId)],
);

/** The audit spine. One row per decision, whether or not anything was executed. */
export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    riskItemId: uuid("risk_item_id").notNull().references(() => riskItems.id),
    scoreId: uuid("score_id").references(() => scores.id),
    diagnosisId: uuid("diagnosis_id").references(() => diagnoses.id),

    /** Winner of the EV ranking. */
    proposedAction: actionType("proposed_action").notNull(),
    expectedValuePaise: integer("expected_value_paise").notNull(),
    actionCostPaise: integer("action_cost_paise").notNull(),

    /** What the LLM suggested, when it was consulted. Divergence is worth surfacing. */
    llmProposedAction: actionType("llm_proposed_action"),
    llmRationale: text("llm_rationale"),

    verdict: policyVerdict("verdict").notNull(),
    /** Ordered, human-readable. This is what the demo renders on a block. */
    verdictReasons: text("verdict_reasons").array().notNull(),
    policyVersion: text("policy_version").notNull(),

    /** Set when the verdict is DELAY. */
    deferredUntil: timestamp("deferred_until", { withTimezone: true }),

    batchId: uuid("batch_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("decisions_risk_item_idx").on(t.riskItemId),
    index("decisions_batch_idx").on(t.batchId),
  ],
);

/** Execution record. The idempotency row is written BEFORE the outbound call. */
export const actionAttempts = pgTable(
  "action_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    decisionId: uuid("decision_id").notNull().references(() => decisions.id),

    /** `${riskItemId}:${action}:${attemptNo}` — see lib/executor.ts */
    idempotencyKey: text("idempotency_key").notNull(),
    attemptNo: integer("attempt_no").default(1).notNull(),

    action: actionType("action").notNull(),
    mode: execMode("mode").notNull(),
    status: attemptStatus("status").default("pending").notNull(),

    /** Razorpay id produced by the action, e.g. plink_… */
    razorpayEntityId: text("razorpay_entity_id"),
    shortUrl: text("short_url"),
    referenceId: text("reference_id"),

    request: jsonb("request").$type<Record<string, unknown>>(),
    response: jsonb("response").$type<Record<string, unknown>>(),
    httpStatus: integer("http_status"),
    error: text("error"),

    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    // CONSTRAINT 2 — a crash mid-flight cannot produce a second payment link.
    uniqueIndex("action_attempts_idempotency_uq").on(t.idempotencyKey),
    index("action_attempts_entity_idx").on(t.razorpayEntityId),
  ],
);

/** Did it work, and how much came back. Attribution must name its evidence. */
export const outcomes = pgTable(
  "outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    decisionId: uuid("decision_id").notNull().references(() => decisions.id),
    riskItemId: uuid("risk_item_id").notNull().references(() => riskItems.id),

    result: outcomeResult("result").default("pending").notNull(),
    recoveredAmountPaise: integer("recovered_amount_paise").default(0).notNull(),
    recoveredAt: timestamp("recovered_at", { withTimezone: true }),

    /** How we know: which webhook event proved it. */
    attributionSource: text("attribution_source"), // payment_link.paid | invoice.paid | order.paid
    verifyingEventId: uuid("verifying_event_id").references(() => webhookEvents.id),

    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("outcomes_decision_uq").on(t.decisionId)],
);

export const escalations = pgTable(
  "escalations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    riskItemId: uuid("risk_item_id").notNull().references(() => riskItems.id),
    decisionId: uuid("decision_id").references(() => decisions.id),

    reason: text("reason").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: text("resolution"),
    /** Did a human agree this needed a human? Feeds escalation precision. */
    wasNecessary: boolean("was_necessary"),
  },
  (t) => [index("escalations_open_idx").on(t.assignedAt).where(sql`${t.resolvedAt} is null`)],
);

/**
 * Contact ledger — one row per customer touch, regardless of channel.
 * The fatigue cap reads this, so it must be written for SIM actions too.
 */
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id").notNull().references(() => customers.id),
    decisionId: uuid("decision_id").references(() => decisions.id),
    channel: text("channel").notNull(), // sms | email
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("contacts_customer_window_idx").on(t.customerId, t.sentAt)],
);
