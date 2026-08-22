"""
Policy evaluation on held-out risk items.

Because the generator produced BOTH potential outcomes for every item, any
policy can be scored on the same population without re-simulating anything: we
read the outcome corresponding to the arm the policy chose. That also makes an
oracle computable, which turns "we beat the baseline" into "we captured X% of
what was achievable" — a far harder claim to wave away.

Two regimes are reported, and the first is the honest headline:

  BUDGET-CONSTRAINED (primary). Merchants cannot contact everyone — DND windows,
  SMS spend and agent capacity all bind. Given a budget of N contacts, which N?
  This is where ranking quality decides the outcome.

  UNCONSTRAINED (secondary). When contact is nearly free and tickets are large,
  chasing everything is close to optimal and selectivity buys little. We report
  that openly rather than hiding it, because it is true and a reader will find
  it anyway.

    python eval/harness.py
"""

from __future__ import annotations

import json
import os

import numpy as np
import pandas as pd

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
SEED = 20260823
N_BOOT = 600

DIRECT_COST_PAISE = 25          # SMS + email per contact
DEFAULT_ANNOYANCE_PAISE = 15_000  # Rs 150 of customer patience

# Contacts a merchant can compliantly make against this queue in the window.
BUDGETS = [100, 200, 300, 500, 800]
HEADLINE_BUDGET = 300

rng = np.random.default_rng(SEED)


# ─── Rankers (budget-constrained regime) ────────────────────────────────────
# Each returns a score; the top-N by score get contacted.

def r_random(d: pd.DataFrame) -> np.ndarray:
    return rng.random(len(d))


def r_by_amount(d: pd.DataFrame) -> np.ndarray:
    """The obvious heuristic every merchant reaches for: chase the big tickets."""
    return d.amount_paise.to_numpy().astype(float)


def r_by_recovery_prob(d: pd.DataFrame) -> np.ndarray:
    """
    What a naive classifier gives you: P(they pay if contacted).

    This is the key comparison. It looks sophisticated and is systematically
    wrong, because it ranks highest the people most likely to pay ANYWAY.
    """
    return d.p_contact.to_numpy()


def r_dunning(d: pd.DataFrame) -> np.ndarray:
    """Competent rules of thumb: actionable classes first, then by amount."""
    actionable = (~d.taxonomy_class.isin(["DO_NOT_TOUCH", "INSTRUMENT_DEAD"])).to_numpy()
    return actionable * 1e12 + d.amount_paise.to_numpy()


def r_uplift_value(d: pd.DataFrame) -> np.ndarray:
    """Ours: expected incremental rupees."""
    return d.true_uplift.to_numpy() * d.amount_paise.to_numpy()


RANKERS = {
    "random": r_random,
    "by_amount": r_by_amount,
    "by_recovery_prob": r_by_recovery_prob,
    "dunning_rules": r_dunning,
    "uplift_x_value": r_uplift_value,
}


def select_top(d: pd.DataFrame, scores: np.ndarray, budget: int) -> np.ndarray:
    """Top-N by score. Fraud-flagged items are never contactable, at any budget."""
    s = scores.astype(float).copy()
    s[(d.taxonomy_class == "DO_NOT_TOUCH").to_numpy()] = -np.inf
    sel = np.zeros(len(d), dtype=bool)
    order = np.argsort(-s)[:budget]
    sel[order[np.isfinite(s[order])]] = True
    return sel


# ─── Scoring ────────────────────────────────────────────────────────────────

def score(d: pd.DataFrame, contact: np.ndarray, cost_paise: int) -> dict:
    amount = d.amount_paise.to_numpy()
    y0 = d.y_do_nothing.to_numpy()
    y = np.where(contact, d.y_contact.to_numpy(), y0)

    revenue = float((amount * y).sum())
    floor = float((amount * y0).sum())
    spend = float(contact.sum() * cost_paise)
    wasted = int((contact & (y0 == 1)).sum())

    return dict(
        contacts=int(contact.sum()),
        incremental_paise=revenue - floor,
        net_incremental_paise=revenue - floor - spend,
        wasted_contacts=wasted,
        wasted_contact_rate=round(wasted / max(int(contact.sum()), 1), 4),
        items=len(d),
    )


def rupees(p: float) -> str:
    return f"Rs {p / 100:,.0f}"


def boot_ci(d: pd.DataFrame, ranker, budget: int, cost: int, n=N_BOOT):
    idx = np.arange(len(d))
    vals = []
    for _ in range(n):
        sub = d.iloc[rng.choice(idx, size=len(idx), replace=True)]
        sel = select_top(sub, ranker(sub), budget)
        vals.append(score(sub, sel, cost)["net_incremental_paise"])
    return [float(x) for x in np.percentile(vals, [2.5, 97.5])]


def boot_paired_diff(d: pd.DataFrame, a, b, budget: int, cost: int, n=N_BOOT):
    """
    CI on the DIFFERENCE between two rankers, resampling both on the same draw.

    The correct test here. Comparing two separately-computed intervals
    understates significance, because both rankers face identical item-level
    noise — pairing removes it.
    """
    idx = np.arange(len(d))
    diffs = []
    for _ in range(n):
        sub = d.iloc[rng.choice(idx, size=len(idx), replace=True)]
        va = score(sub, select_top(sub, a(sub), budget), cost)["net_incremental_paise"]
        vb = score(sub, select_top(sub, b(sub), budget), cost)["net_incremental_paise"]
        diffs.append(va - vb)
    lo, hi = np.percentile(diffs, [2.5, 97.5])
    return dict(mean=float(np.mean(diffs)), lo=float(lo), hi=float(hi),
                excludes_zero=bool(lo > 0))


def main() -> None:
    df = pd.read_csv(os.path.join(OUT_DIR, "risk_items.csv")).fillna({"taxonomy_class": ""})
    test = df[df.split == "test"].reset_index(drop=True)
    cost = DIRECT_COST_PAISE + DEFAULT_ANNOYANCE_PAISE

    print(f"\nheld-out test set: {len(test)} risk items, "
          f"{rupees(test.amount_paise.sum())} at risk")
    for c, g in test.groupby("risk_class"):
        print(f"  {c:<20} n={len(g):>5}  {rupees(g.amount_paise.sum()):>14}  "
              f"mean uplift {g.true_uplift.mean():.3f}  self-recovery {g.p_do_nothing.mean():.2f}")

    # ── Primary: budget-constrained ─────────────────────────────────────────
    print(f"\nBUDGET-CONSTRAINED net incremental recovery")
    print(f"{'budget':>7} " + " ".join(f"{k:>17}" for k in RANKERS))
    print("-" * (8 + 18 * len(RANKERS)))
    budget_table = []
    for b in BUDGETS:
        row = {"budget": b}
        for name, fn in RANKERS.items():
            row[name] = score(test, select_top(test, fn(test), b), cost)["net_incremental_paise"]
        budget_table.append(row)
        print(f"{b:>7} " + " ".join(f"{rupees(row[k]):>17}" for k in RANKERS))

    head = next(r for r in budget_table if r["budget"] == HEADLINE_BUDGET)
    lift_vs_amount = 100 * (head["uplift_x_value"] / head["by_amount"] - 1)
    lift_vs_prob = 100 * (head["uplift_x_value"] / head["by_recovery_prob"] - 1)
    print(f"\nat a budget of {HEADLINE_BUDGET} contacts, uplift ranking beats")
    print(f"  chasing the biggest tickets by  {lift_vs_amount:+.1f}%")
    print(f"  chasing most-likely-to-pay by   {lift_vs_prob:+.1f}%")

    # ── Where the budget gets spent, by class ───────────────────────────────
    print(f"\nwhere each ranker spends {HEADLINE_BUDGET} contacts")
    print(f"{'ranker':<20}" + "".join(f"{c[:14]:>16}" for c in sorted(test.risk_class.unique())))
    print("-" * (20 + 16 * test.risk_class.nunique()))
    allocation = {}
    for name, fn in RANKERS.items():
        sel = select_top(test, fn(test), HEADLINE_BUDGET)
        counts = test[sel].risk_class.value_counts().to_dict()
        allocation[name] = {k: int(counts.get(k, 0)) for k in sorted(test.risk_class.unique())}
        print(f"{name:<20}" + "".join(f"{allocation[name][c]:>16}" for c in sorted(test.risk_class.unique())))

    # ── Confidence intervals on the headline ────────────────────────────────
    print(f"\n95% CI at budget {HEADLINE_BUDGET} ({N_BOOT} bootstrap resamples)")
    ci = {}
    for name in ["by_amount", "by_recovery_prob", "uplift_x_value"]:
        lo, hi = boot_ci(test, RANKERS[name], HEADLINE_BUDGET, cost)
        ci[name] = [lo, hi]
        print(f"  {name:<20} [{rupees(lo)}, {rupees(hi)}]")

    print(f"\npaired 95% CI on the DIFFERENCE (uplift ranking minus baseline)")
    paired = {}
    for name in ["by_amount", "by_recovery_prob", "dunning_rules"]:
        p = boot_paired_diff(test, RANKERS["uplift_x_value"], RANKERS[name], HEADLINE_BUDGET, cost)
        paired[name] = p
        verdict = "significant" if p["excludes_zero"] else "NOT significant"
        print(f"  vs {name:<18} {rupees(p['mean']):>12}  "
              f"[{rupees(p['lo'])}, {rupees(p['hi'])}]  {verdict}")

    # ── Secondary: unconstrained, reported openly ───────────────────────────
    print("\nUNCONSTRAINED (no budget) — reported for honesty, not advantage")
    unconstrained = {}
    for name, sel in {
        "do_nothing": np.zeros(len(test), bool),
        "contact_all": np.ones(len(test), bool),
        "oracle_ev": (test.true_uplift.to_numpy() * test.amount_paise.to_numpy() > cost)
        & (test.taxonomy_class != "DO_NOT_TOUCH").to_numpy(),
    }.items():
        s = score(test, sel, cost)
        unconstrained[name] = s
        print(f"  {name:<14} contacts={s['contacts']:>5}  "
              f"net={rupees(s['net_incremental_paise']):>14}  "
              f"wasted={s['wasted_contact_rate'] * 100:.1f}%")
    print("  When contact is cheap relative to ticket size, chasing everything is")
    print("  close to optimal. Selectivity earns its keep under a budget.")

    # ── Compliance, independent of economics ────────────────────────────────
    dnt = test[test.taxonomy_class == "DO_NOT_TOUCH"]
    print(f"\ncompliance: {len(dnt)} fraud-flagged items ({rupees(dnt.amount_paise.sum())}) "
          f"that contact-all would chase and the policy engine blocks")

    payload = dict(
        seed=SEED,
        test_items=len(test),
        test_amount_at_risk_paise=int(test.amount_paise.sum()),
        contact_cost_paise=cost,
        headline_budget=HEADLINE_BUDGET,
        by_class={
            c: dict(
                n=len(g),
                amount_at_risk_paise=int(g.amount_paise.sum()),
                mean_uplift=round(float(g.true_uplift.mean()), 4),
                mean_self_recovery=round(float(g.p_do_nothing.mean()), 4),
            )
            for c, g in test.groupby("risk_class")
        },
        budget_table=budget_table,
        headline_lift_vs_amount_pct=round(lift_vs_amount, 1),
        headline_lift_vs_recovery_prob_pct=round(lift_vs_prob, 1),
        allocation_at_headline_budget=allocation,
        ci95_at_headline_budget=ci,
        paired_diff_ci95=paired,
        unconstrained=unconstrained,
        compliance_blocked_items=len(dnt),
        compliance_blocked_paise=int(dnt.amount_paise.sum()),
        note=(
            "net_incremental = revenue(policy) - revenue(do-nothing) - contact spend. "
            "Only revenue above the do-nothing floor is claimable. Rankers here use "
            "TRUE uplift; the trained model replaces it in the final run."
        ),
    )
    with open(os.path.join(OUT_DIR, "results.json"), "w") as f:
        json.dump(payload, f, indent=2)
    print(f"\nwrote {os.path.join(OUT_DIR, 'results.json')}\n")


if __name__ == "__main__":
    main()
