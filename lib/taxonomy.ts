/**
 * Failure taxonomy — deterministic, never a model.
 *
 * Every value here is documented by Razorpay as a possible `error_reason`.
 * The classification drives recoverability, which drives the policy engine,
 * so it must be reproducible and auditable. See DECISIONS.md §3.
 *
 * An unmapped reason THROWS. It never silently falls into a bucket — a wrong
 * bucket is a wrong money decision, and a loud failure is cheaper than a quiet one.
 */

export type TaxonomyClass =
  | "TRANSIENT"
  | "CUSTOMER_FIXABLE"
  | "INSTRUMENT_DEAD"
  | "DO_NOT_TOUCH"
  | "OPAQUE";

export const TAXONOMY: Record<string, TaxonomyClass> = {
  // Infrastructure blipped. High self-recovery — which is exactly why uplift
  // here is lower than raw probability suggests.
  gateway_technical_error: "TRANSIENT",
  bank_technical_error: "TRANSIENT",
  payment_timed_out: "TRANSIENT",
  server_error: "TRANSIENT",

  // The customer can fix this. Timing is the lever.
  payment_cancelled: "CUSTOMER_FIXABLE",
  authentication_failed: "CUSTOMER_FIXABLE",
  incorrect_cvv: "CUSTOMER_FIXABLE",
  insufficient_funds: "CUSTOMER_FIXABLE",
  invalid_otp: "CUSTOMER_FIXABLE",

  // The instrument is dead. Nudging the same one is guaranteed waste;
  // only an alternative-method link has any uplift.
  card_expired: "INSTRUMENT_DEAD",
  debit_instrument_blocked: "INSTRUMENT_DEAD",
  debit_instrument_inactive: "INSTRUMENT_DEAD",
  card_not_enrolled: "INSTRUMENT_DEAD",
  card_disabled_for_online_payments: "INSTRUMENT_DEAD",
  international_transaction_not_allowed: "INSTRUMENT_DEAD",

  // The bank flagged fraud. Automated pursuit is a compliance hazard.
  payment_risk_check_failed: "DO_NOT_TOUCH",

  // The bank told us nothing. This is where the learned model earns its keep.
  card_declined: "OPAQUE",
  payment_failed: "OPAQUE",
  transaction_limit_exceeded: "OPAQUE",
};

/** Human-readable, deterministic. Used when the LLM is unavailable. */
export const CLASS_SUMMARY: Record<TaxonomyClass, string> = {
  TRANSIENT:
    "Infrastructure-side failure. Often resolves without intervention, so contacting the customer may earn nothing.",
  CUSTOMER_FIXABLE:
    "The customer can complete this themselves. Timing of the nudge matters more than the nudge itself.",
  INSTRUMENT_DEAD:
    "The payment instrument cannot succeed. Only an alternative payment method has any chance.",
  DO_NOT_TOUCH:
    "The bank flagged this transaction. Automated pursuit is not appropriate; route to a human.",
  OPAQUE:
    "The bank declined without a stated reason. Recoverability must be predicted rather than read.",
};

export class UnmappedErrorReason extends Error {
  constructor(public readonly reason: string) {
    super(`Unmapped Razorpay error_reason: "${reason}"`);
    this.name = "UnmappedErrorReason";
  }
}

/** Throws on an unknown reason. */
export function classify(errorReason: string | null | undefined): TaxonomyClass {
  if (!errorReason) throw new UnmappedErrorReason("<missing>");
  const cls = TAXONOMY[errorReason];
  if (!cls) throw new UnmappedErrorReason(errorReason);
  return cls;
}

export type ClassifyResult =
  | { ok: true; class: TaxonomyClass; summary: string }
  | { ok: false; reason: string };

/**
 * Non-throwing variant for pipeline code. An unmapped reason is surfaced to the
 * caller, which routes the item to ESCALATE rather than guessing.
 */
export function tryClassify(errorReason: string | null | undefined): ClassifyResult {
  try {
    const cls = classify(errorReason);
    return { ok: true, class: cls, summary: CLASS_SUMMARY[cls] };
  } catch {
    return { ok: false, reason: errorReason ?? "<missing>" };
  }
}

/** Classes for which contacting the customer about the SAME instrument is pointless. */
export function requiresAlternativeMethod(cls: TaxonomyClass): boolean {
  return cls === "INSTRUMENT_DEAD";
}

/** Classes that must never receive an automated action. */
export function mustEscalate(cls: TaxonomyClass): boolean {
  return cls === "DO_NOT_TOUCH";
}
