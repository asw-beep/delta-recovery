/**
 * Expected value of a recovery action, in paise.
 *
 * Pure arithmetic, no model, no I/O — DECISIONS.md §9 puts every rupee
 * calculation on the deterministic side of the trust boundary. The LLM never
 * touches this file, and a judge asking "what if it hallucinates a number?"
 * can be shown that the numbers are not generated at all.
 *
 * The formula that carries the product:
 *
 *   EV(a) = uplift(a) x amount − direct_cost(a) − patience_cost(a)
 *
 * `uplift`, not P(recovery). Ranking by probability of payment systematically
 * selects the customers most likely to pay ANYWAY, which is spend without
 * return. See eval/results.json — it costs 66% of achievable recovery.
 */

export type Action =
  | "ISSUE_RECOVERY_LINK"
  | "NUDGE_SMS"
  | "NUDGE_EMAIL"
  | "CHASE_INVOICE"
  | "DEFER"
  | "WITHDRAW"
  | "ESCALATE_HUMAN"
  | "STOP";

export interface ActionCost {
  /** Money actually spent: SMS, email, agent time. */
  directPaise: number;
  /**
   * Whether this action consumes a unit of customer patience.
   *
   * Not a real invoice line, but a real cost: channel degradation, opt-outs and
   * brand damage are what stop a merchant contacting everyone. Priced as config
   * so a reader can change it and watch the policy shift.
   */
  consumesPatience: boolean;
}

export const ACTION_COSTS: Record<Action, ActionCost> = {
  ISSUE_RECOVERY_LINK: { directPaise: 0, consumesPatience: false },
  NUDGE_SMS: { directPaise: 20, consumesPatience: true },
  NUDGE_EMAIL: { directPaise: 5, consumesPatience: true },
  CHASE_INVOICE: { directPaise: 20, consumesPatience: true },
  DEFER: { directPaise: 0, consumesPatience: false },
  WITHDRAW: { directPaise: 0, consumesPatience: false },
  ESCALATE_HUMAN: { directPaise: 4_500, consumesPatience: false },
  STOP: { directPaise: 0, consumesPatience: false },
};

/** Rs 150. Matches DEFAULT_ANNOYANCE_PAISE in eval/harness.py. */
export const PATIENCE_COST_PAISE = 15_000;

export const CONTACTING_ACTIONS: readonly Action[] = [
  "NUDGE_SMS",
  "NUDGE_EMAIL",
  "CHASE_INVOICE",
];

export function isContact(action: Action): boolean {
  return CONTACTING_ACTIONS.includes(action);
}

export interface EvInput {
  /** P(pay | contact) − P(pay | do nothing). Never a raw recovery probability. */
  uplift: number;
  amountPaise: number;
  action: Action;
  patienceCostPaise?: number;
}

export interface EvResult {
  /** Incremental rupees we expect the action to produce. */
  grossPaise: number;
  costPaise: number;
  /** What the policy engine ranks on. */
  netPaise: number;
}

export function expectedValue(input: EvInput): EvResult {
  const { uplift, amountPaise, action } = input;
  const patience = input.patienceCostPaise ?? PATIENCE_COST_PAISE;
  const spec = ACTION_COSTS[action];

  // Uplift is the incremental effect OF CONTACTING. An action that does not
  // reach the customer realises none of it.
  //
  // Getting this wrong is not a rounding error: if STOP is credited with the
  // full uplift at zero cost, STOP outranks every real action and the agent
  // proposes doing nothing for every item — while still scoring it as the
  // highest-value option. Do-nothing is worth exactly zero, by definition.
  const gross = isContact(action) ? Math.round(uplift * amountPaise) : 0;
  const cost = spec.directPaise + (spec.consumesPatience ? patience : 0);

  return { grossPaise: gross, costPaise: cost, netPaise: gross - cost };
}

/**
 * Which action to propose for a risk class, before policy evaluation.
 *
 * Receivables are deliberately different: we re-notify an invoice that already
 * exists rather than minting a payment link. That is both correct (the invoice
 * is the instrument of record) and practical — it does not consume the ~30
 * test-mode payment-link budget documented in DECISIONS.md §3.
 */
export function candidateActions(
  riskClass: "failed_payment" | "abandoned_checkout" | "overdue_receivable",
): Action[] {
  if (riskClass === "overdue_receivable") {
    return ["CHASE_INVOICE", "ESCALATE_HUMAN", "STOP"];
  }
  return ["NUDGE_SMS", "NUDGE_EMAIL", "ESCALATE_HUMAN", "STOP"];
}

/** Highest-EV action, with do-nothing always in the running at EV 0. */
export function rankActions(
  actions: Action[],
  uplift: number,
  amountPaise: number,
  patienceCostPaise?: number,
): Array<{ action: Action; ev: EvResult }> {
  return actions
    .map((action) => ({
      action,
      ev: expectedValue({ uplift, amountPaise, action, patienceCostPaise }),
    }))
    .sort((a, b) => b.ev.netPaise - a.ev.netPaise);
}
