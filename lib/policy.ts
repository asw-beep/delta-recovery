import { isContact, type Action } from "./ev";
import type { TaxonomyClass } from "./taxonomy";

/**
 * The policy engine.
 *
 * Sits between what the model proposes and what the system does. Pure function,
 * no I/O, no model — the caller assembles the context and this decides. Every
 * rule returns an attributed reason, because "the agent refused and can tell you
 * which rule stopped it" is the behaviour Track 03 asks for, and a blocked
 * action with no explanation is worth nothing.
 *
 * Rules are ordered: hard prohibitions first, then compliance, then economics.
 * The first STOP or ESCALATE wins, so a fraud-flagged item can never be talked
 * into a contact by a large expected value.
 */

export type RiskClass = "failed_payment" | "abandoned_checkout" | "overdue_receivable";
export type Verdict = "ALLOW" | "DELAY" | "ESCALATE" | "STOP";

export const POLICY_VERSION = "1.0.0";

export interface PolicyConfig {
  highValuePaise: number;
  maxContactsPer7d: number;
  maxActionsPerItem: number;
  /** Recovery window per class, in hours. */
  windowHours: Record<RiskClass, number>;
  minNetEvPaise: number;
  minUplift: number;
  dailySpendCapPaise: number;
  /** Consumer quiet hours in IST, [startHour, endHour) — no contact inside. */
  quietHoursIst: [number, number];
  /** B2B contact window in IST; receivables are chased in business hours only. */
  businessHoursIst: [number, number];
}

export const DEFAULT_POLICY: PolicyConfig = {
  highValuePaise: 2_500_000, // Rs 25,000
  maxContactsPer7d: 3,
  maxActionsPerItem: 2,
  windowHours: {
    failed_payment: 72,
    abandoned_checkout: 72,
    overdue_receivable: 24 * 14,
  },
  minNetEvPaise: 500, // Rs 5
  minUplift: 0.03,
  dailySpendCapPaise: 500_000, // Rs 5,000
  quietHoursIst: [21, 9],
  businessHoursIst: [9, 18],
};

export interface PolicyContext {
  riskClass: RiskClass;
  action: Action;
  amountPaise: number;
  taxonomyClass: TaxonomyClass | null;

  /** Null means the scorer was unavailable or the item is out of distribution. */
  uplift: number | null;
  netEvPaise: number | null;

  detectedAt: Date;
  now: Date;

  customerOptedOut: boolean;
  /** Re-read from Razorpay immediately before executing, never from cache. */
  alreadySettled: boolean;
  duplicateAction: boolean;

  contactsInWindow7d: number;
  actionsOnItem: number;
  downtimeOpen: boolean;
  spendTodayPaise: number;
}

export interface PolicyDecision {
  verdict: Verdict;
  reasons: string[];
  deferredUntil?: Date;
  policyVersion: string;
}

/** IST is UTC+5:30 with no DST, so a fixed offset is exact rather than a shortcut. */
const IST_OFFSET_MIN = 5 * 60 + 30;

export function istHour(d: Date): number {
  return new Date(d.getTime() + IST_OFFSET_MIN * 60_000).getUTCHours();
}

function inQuietHours(hour: number, [start, end]: [number, number]): boolean {
  // Wraps midnight when start > end, e.g. 21:00-09:00.
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

function nextAllowedTime(now: Date, targetIstHour: number): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  const next = new Date(ist);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(targetIstHour);
  if (next <= ist) next.setUTCDate(next.getUTCDate() + 1);
  return new Date(next.getTime() - IST_OFFSET_MIN * 60_000);
}

export function evaluate(
  ctx: PolicyContext,
  config: PolicyConfig = DEFAULT_POLICY,
): PolicyDecision {
  const reasons: string[] = [];
  const done = (verdict: Verdict, reason: string, deferredUntil?: Date): PolicyDecision => {
    reasons.push(reason);
    return { verdict, reasons, deferredUntil, policyVersion: POLICY_VERSION };
  };

  // Non-contacting actions bypass the contact rules entirely.
  const contacting = isContact(ctx.action);

  // ── Hard prohibitions ───────────────────────────────────────────────────
  if (ctx.customerOptedOut) {
    return done("STOP", "Customer has opted out of automated contact");
  }
  if (ctx.alreadySettled) {
    return done("STOP", "Money already received — nothing left at risk");
  }
  if (ctx.duplicateAction) {
    return done("STOP", "An identical action already exists for this item");
  }

  // ── Compliance ──────────────────────────────────────────────────────────
  if (ctx.taxonomyClass === "DO_NOT_TOUCH") {
    return done(
      "ESCALATE",
      "Bank flagged this transaction for risk — automated pursuit is not permitted",
    );
  }
  if (ctx.amountPaise >= config.highValuePaise) {
    return done(
      "ESCALATE",
      `Amount is at or above the high-value threshold (Rs ${config.highValuePaise / 100}) — needs human approval`,
    );
  }

  // ── Model availability ──────────────────────────────────────────────────
  // Degrade to a human, never to a guessed probability.
  if (ctx.uplift === null || ctx.netEvPaise === null) {
    return done("ESCALATE", "Recovery scorer unavailable — routed for human review");
  }

  // ── Fatigue and exhaustion ──────────────────────────────────────────────
  if (contacting && ctx.contactsInWindow7d >= config.maxContactsPer7d) {
    return done(
      "STOP",
      `Contact fatigue cap reached (${ctx.contactsInWindow7d}/${config.maxContactsPer7d} in the last 7 days)`,
    );
  }
  if (ctx.actionsOnItem >= config.maxActionsPerItem) {
    return done(
      "STOP",
      `Maximum actions for this item reached (${ctx.actionsOnItem}/${config.maxActionsPerItem})`,
    );
  }

  const ageHours = (ctx.now.getTime() - ctx.detectedAt.getTime()) / 3_600_000;
  const window = config.windowHours[ctx.riskClass];
  if (ageHours > window) {
    return done(
      "STOP",
      `Recovery window expired (${Math.round(ageHours)}h elapsed, limit ${window}h for ${ctx.riskClass})`,
    );
  }

  // ── Timing ──────────────────────────────────────────────────────────────
  if (contacting) {
    const hour = istHour(ctx.now);
    if (ctx.riskClass === "overdue_receivable") {
      const [open, close] = config.businessHoursIst;
      if (hour < open || hour >= close) {
        return done(
          "DELAY",
          `Outside business hours (${open}:00-${close}:00 IST) — receivables are chased in working hours`,
          nextAllowedTime(ctx.now, open),
        );
      }
    } else if (inQuietHours(hour, config.quietHoursIst)) {
      const [, end] = config.quietHoursIst;
      return done(
        "DELAY",
        `Quiet hours (${config.quietHoursIst[0]}:00-${end}:00 IST) — deferred to protect the customer`,
        nextAllowedTime(ctx.now, end),
      );
    }
  }

  if (ctx.downtimeOpen) {
    return done(
      "DELAY",
      "Payment method is in an active outage — a link sent now would fail too",
    );
  }

  if (ctx.spendTodayPaise >= config.dailySpendCapPaise) {
    return done(
      "DELAY",
      `Daily automated spend cap reached (Rs ${config.dailySpendCapPaise / 100})`,
    );
  }

  // ── Economics ───────────────────────────────────────────────────────────
  if (ctx.uplift < config.minUplift) {
    return done(
      "STOP",
      `Estimated uplift ${ctx.uplift.toFixed(3)} is below the floor (${config.minUplift}) — this customer would most likely pay anyway`,
    );
  }
  if (ctx.netEvPaise < config.minNetEvPaise) {
    return done(
      "STOP",
      `Net expected value Rs ${(ctx.netEvPaise / 100).toFixed(2)} is below the floor (Rs ${config.minNetEvPaise / 100}) — not worth the contact`,
    );
  }

  reasons.push(
    `Uplift ${ctx.uplift.toFixed(3)} on Rs ${(ctx.amountPaise / 100).toLocaleString("en-IN")} gives net EV Rs ${(ctx.netEvPaise / 100).toFixed(2)}`,
    `${ctx.contactsInWindow7d}/${config.maxContactsPer7d} contacts used in the last 7 days`,
    `Within the ${window}h recovery window for ${ctx.riskClass}`,
  );
  return { verdict: "ALLOW", reasons, policyVersion: POLICY_VERSION };
}
