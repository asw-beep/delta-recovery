import { describe, expect, it } from "vitest";
import { expectedValue, rankActions, PATIENCE_COST_PAISE, candidateActions } from "./ev";
import {
  DEFAULT_POLICY,
  evaluate,
  istHour,
  type PolicyContext,
} from "./policy";

/**
 * One test per policy rule proving it actually blocks, plus a property test
 * asserting no ALLOW can ever be issued below the EV floor.
 *
 * These are the tests that matter most in the project: the policy engine is the
 * thing standing between a model's opinion and someone's money.
 */

/** A context that passes every rule, so each test can break exactly one thing. */
function baseline(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    riskClass: "failed_payment",
    action: "NUDGE_SMS",
    amountPaise: 849_900, // Rs 8,499
    taxonomyClass: "CUSTOMER_FIXABLE",
    uplift: 0.25,
    netEvPaise: 197_455,
    detectedAt: new Date("2026-08-23T06:00:00Z"),
    now: new Date("2026-08-23T09:00:00Z"), // 14:30 IST — inside every window
    customerOptedOut: false,
    alreadySettled: false,
    duplicateAction: false,
    contactsInWindow7d: 0,
    actionsOnItem: 0,
    downtimeOpen: false,
    spendTodayPaise: 0,
    ...over,
  };
}

describe("policy engine", () => {
  it("allows a healthy, high-uplift item inside every limit", () => {
    const d = evaluate(baseline());
    expect(d.verdict).toBe("ALLOW");
    expect(d.reasons.length).toBeGreaterThan(0);
    expect(d.policyVersion).toBeTruthy();
  });

  it("stops when the customer has opted out", () => {
    const d = evaluate(baseline({ customerOptedOut: true }));
    expect(d.verdict).toBe("STOP");
    expect(d.reasons[0]).toMatch(/opted out/i);
  });

  it("stops when the money already arrived", () => {
    const d = evaluate(baseline({ alreadySettled: true }));
    expect(d.verdict).toBe("STOP");
    expect(d.reasons[0]).toMatch(/already received/i);
  });

  it("stops on a duplicate action", () => {
    const d = evaluate(baseline({ duplicateAction: true }));
    expect(d.verdict).toBe("STOP");
    expect(d.reasons[0]).toMatch(/identical action/i);
  });

  it("escalates fraud-flagged items and never contacts them", () => {
    const d = evaluate(baseline({ taxonomyClass: "DO_NOT_TOUCH" }));
    expect(d.verdict).toBe("ESCALATE");
    expect(d.reasons[0]).toMatch(/risk/i);
  });

  it("escalates fraud-flagged items even when the expected value is enormous", () => {
    // Economics must never override compliance.
    const d = evaluate(
      baseline({ taxonomyClass: "DO_NOT_TOUCH", uplift: 0.9, netEvPaise: 90_000_000 }),
    );
    expect(d.verdict).toBe("ESCALATE");
  });

  it("escalates high-value items for human approval", () => {
    const d = evaluate(baseline({ amountPaise: 2_500_000 }));
    expect(d.verdict).toBe("ESCALATE");
    expect(d.reasons[0]).toMatch(/high-value/i);
  });

  it("escalates rather than guessing when the scorer is unavailable", () => {
    const d = evaluate(baseline({ uplift: null, netEvPaise: null }));
    expect(d.verdict).toBe("ESCALATE");
    expect(d.reasons[0]).toMatch(/scorer unavailable/i);
  });

  it("stops at the contact fatigue cap", () => {
    const d = evaluate(baseline({ contactsInWindow7d: 3 }));
    expect(d.verdict).toBe("STOP");
    expect(d.reasons[0]).toMatch(/fatigue/i);
  });

  it("stops when the item has had its maximum actions", () => {
    const d = evaluate(baseline({ actionsOnItem: 2 }));
    expect(d.verdict).toBe("STOP");
    expect(d.reasons[0]).toMatch(/maximum actions/i);
  });

  it("stops once the recovery window expires", () => {
    const d = evaluate(
      baseline({
        detectedAt: new Date("2026-08-19T06:00:00Z"), // 99h earlier
        now: new Date("2026-08-23T09:00:00Z"),
      }),
    );
    expect(d.verdict).toBe("STOP");
    expect(d.reasons[0]).toMatch(/window expired/i);
  });

  it("gives receivables a longer window than payments", () => {
    const old = {
      detectedAt: new Date("2026-08-19T06:00:00Z"),
      now: new Date("2026-08-23T09:00:00Z"),
    };
    expect(evaluate(baseline({ ...old })).verdict).toBe("STOP");
    expect(
      evaluate(
        baseline({
          ...old,
          riskClass: "overdue_receivable",
          action: "CHASE_INVOICE",
          taxonomyClass: null,
        }),
      ).verdict,
    ).toBe("ALLOW");
  });

  it("delays consumer contact during quiet hours", () => {
    // 18:00 UTC = 23:30 IST
    const d = evaluate(baseline({ now: new Date("2026-08-23T18:00:00Z") }));
    expect(d.verdict).toBe("DELAY");
    expect(d.reasons[0]).toMatch(/quiet hours/i);
    expect(d.deferredUntil).toBeInstanceOf(Date);
    expect(d.deferredUntil!.getTime()).toBeGreaterThan(
      new Date("2026-08-23T18:00:00Z").getTime(),
    );
  });

  it("delays receivables outside business hours", () => {
    // 13:00 UTC = 18:30 IST — fine for consumers, outside B2B hours
    const ctx = baseline({
      riskClass: "overdue_receivable",
      action: "CHASE_INVOICE",
      taxonomyClass: null,
      now: new Date("2026-08-23T13:00:00Z"),
    });
    expect(evaluate(ctx).verdict).toBe("DELAY");
    // The same moment is perfectly fine for a consumer nudge.
    expect(evaluate(baseline({ now: new Date("2026-08-23T13:00:00Z") })).verdict).toBe("ALLOW");
  });

  it("defers into an active outage rather than burning the contact", () => {
    const d = evaluate(baseline({ downtimeOpen: true }));
    expect(d.verdict).toBe("DELAY");
    expect(d.reasons[0]).toMatch(/outage/i);
  });

  it("delays once the daily spend cap is reached", () => {
    const d = evaluate(baseline({ spendTodayPaise: DEFAULT_POLICY.dailySpendCapPaise }));
    expect(d.verdict).toBe("DELAY");
    expect(d.reasons[0]).toMatch(/spend cap/i);
  });

  it("stops when uplift says the customer would pay anyway", () => {
    const d = evaluate(baseline({ uplift: 0.01, netEvPaise: 8_499 }));
    expect(d.verdict).toBe("STOP");
    expect(d.reasons[0]).toMatch(/pay anyway/i);
  });

  it("stops when net expected value is below the floor", () => {
    const d = evaluate(baseline({ uplift: 0.2, netEvPaise: 100 }));
    expect(d.verdict).toBe("STOP");
    expect(d.reasons[0]).toMatch(/expected value/i);
  });

  it("does not apply contact rules to non-contacting actions", () => {
    // Fatigue is about contacting; escalation is not a contact.
    const d = evaluate(baseline({ action: "ESCALATE_HUMAN", contactsInWindow7d: 9 }));
    expect(d.verdict).toBe("ALLOW");
  });

  it("PROPERTY: never allows an action below the EV or uplift floor", () => {
    for (let i = 0; i < 3000; i++) {
      const uplift = Math.random() * 0.5;
      const amountPaise = Math.floor(Math.random() * 2_400_000) + 1;
      const { netPaise } = expectedValue({ uplift, amountPaise, action: "NUDGE_SMS" });
      const d = evaluate(baseline({ uplift, amountPaise, netEvPaise: netPaise }));
      if (d.verdict === "ALLOW") {
        expect(uplift).toBeGreaterThanOrEqual(DEFAULT_POLICY.minUplift);
        expect(netPaise).toBeGreaterThanOrEqual(DEFAULT_POLICY.minNetEvPaise);
      }
    }
  });
});

describe("expected value", () => {
  it("prices a contact as uplift x amount minus direct and patience cost", () => {
    const r = expectedValue({ uplift: 0.25, amountPaise: 849_900, action: "NUDGE_SMS" });
    expect(r.grossPaise).toBe(212_475);
    expect(r.costPaise).toBe(20 + PATIENCE_COST_PAISE);
    expect(r.netPaise).toBe(212_475 - 20 - PATIENCE_COST_PAISE);
  });

  it("charges no patience cost for actions that do not contact anyone", () => {
    expect(expectedValue({ uplift: 0.3, amountPaise: 100_000, action: "STOP" }).costPaise).toBe(0);
    expect(
      expectedValue({ uplift: 0.3, amountPaise: 100_000, action: "ISSUE_RECOVERY_LINK" }).costPaise,
    ).toBe(0);
  });

  it("makes email cheaper than SMS, so ties break toward the cheaper channel", () => {
    const [best] = rankActions(["NUDGE_SMS", "NUDGE_EMAIL"], 0.2, 500_000);
    expect(best.action).toBe("NUDGE_EMAIL");
  });

  it("ranks STOP above a contact when uplift cannot pay for it", () => {
    const [best] = rankActions(["NUDGE_SMS", "STOP"], 0.001, 100_000);
    expect(best.action).toBe("STOP");
  });

  it("routes receivables to invoice chasing, never to a new payment link", () => {
    const actions = candidateActions("overdue_receivable");
    expect(actions).toContain("CHASE_INVOICE");
    expect(actions).not.toContain("ISSUE_RECOVERY_LINK");
  });
});

describe("IST handling", () => {
  it("converts UTC to IST correctly across the date boundary", () => {
    expect(istHour(new Date("2026-08-23T09:00:00Z"))).toBe(14); // 14:30 IST
    expect(istHour(new Date("2026-08-23T18:00:00Z"))).toBe(23); // 23:30 IST
    expect(istHour(new Date("2026-08-23T20:00:00Z"))).toBe(1); // 01:30 IST next day
  });
});
