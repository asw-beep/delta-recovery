"""
Policy evaluation on held-out risk items, with a do-nothing floor and an
oracle ceiling.

Because the generator produced BOTH potential outcomes for every item, any
policy can be scored on the same population without re-simulating anything:
we simply read the outcome corresponding to the arm the policy chose. That
also makes an oracle computable, which is what turns "we beat the baseline"
into "we captured X% of what was achievable" — a far harder claim to wave away.

The headline metric is NET INCREMENTAL recovery:

    net(policy) = revenue(policy) − revenue(do-nothing) − contact costs

Revenue above the do-nothing floor is the only revenue we can honestly claim.

    python eval/harness.py
"""

from __future__ import annotations

import json
import os

import numpy as np
import pandas as pd

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
SEED = 20260823
N_BOOT = 1000

# Direct spend per contact: one payment link (free) plus SMS and email.
DIRECT_COST_PAISE = 25

# Expected cost of consuming a unit of customer patience — channel degradation,
# opt-outs, brand damage. Not directly observable, so it is a parameter we sweep
# rather than a number we assert. See `sweep` in the results.
DEFAULT_ANNOYANCE_PAISE = 15_000  # Rs 150

rng = np.random.default_rng(SEED)


# ─── Policies ───────────────────────────────────────────────────────────────
# Each returns a boolean array: contact this item or not.

def p_do_nothing(df: pd.DataFrame, **_) -> np.ndarray:
    """B0 — the floor. Whatever recovers here recovers on its own."""
    return np.zeros(len(df), dtype=bool)


def p_contact_all(df: pd.DataFrame, **_) -> np.ndarray:
    """B1 — the naive agent. Chase every failure once."""
    return np.ones(len(df), dtype=bool)


def p_dunning(df: pd.DataFrame, **_) -> np.ndarray:
    """
    B2 — competent rules of thumb, the policy a good team ships without ML.

    Skips the two classes any sensible person skips, and respects a contact cap.
    Note this is an adaptation of a day-0/3/7 ladder: our unit of analysis is one
    decision per risk item, not a scheduled sequence, so the ladder collapses to
    "contact unless there is an obvious reason not to".
    """
    return (
        (~df.taxonomy_class.isin(["DO_NOT_TOUCH", "INSTRUMENT_DEAD"]))
        & (df.prior_contacts_7d < 3)
    ).to_numpy()


def p_oracle(df: pd.DataFrame, cost_paise: int, **_) -> np.ndarray:
    """
    ORACLE — knows each item's TRUE uplift and maximises expected value.

    Unachievable by construction: no model recovers the true parameter. It is
    the ceiling that bounds every claim we make.
    """
    ev = df.true_uplift.to_numpy() * df.amount_paise.to_numpy() - cost_paise
    return (ev > 0) & (df.taxonomy_class != "DO_NOT_TOUCH").to_numpy()


POLICIES = {
    "B0_do_nothing": p_do_nothing,
    "B1_contact_all": p_contact_all,
    "B2_dunning_rules": p_dunning,
    "ORACLE": p_oracle,
}


# ─── Scoring ────────────────────────────────────────────────────────────────

def outcomes(df: pd.DataFrame, contact: np.ndarray) -> np.ndarray:
    """Realised payment indicator under the arm the policy chose."""
    return np.where(contact, df.y_contact.to_numpy(), df.y_do_nothing.to_numpy())


def score(df: pd.DataFrame, contact: np.ndarray, cost_paise: int) -> dict:
    amount = df.amount_paise.to_numpy()
    y = outcomes(df, contact)
    y0 = df.y_do_nothing.to_numpy()

    revenue = float((amount * y).sum())
    floor = float((amount * y0).sum())
    spend = float(contact.sum() * cost_paise)

    # Contacts spent on people who were going to pay regardless. This is the
    # number naive systems never report.
    wasted = int((contact & (y0 == 1)).sum())

    return dict(
        contacts=int(contact.sum()),
        recovered_paise=revenue,
        incremental_paise=revenue - floor,
        net_incremental_paise=revenue - floor - spend,
        spend_paise=spend,
        wasted_contacts=wasted,
        wasted_contact_rate=round(wasted / max(int(contact.sum()), 1), 4),
        recovery_rate=round(float(y.mean()), 4),
        items=len(df),
    )


def bootstrap_net(df: pd.DataFrame, fn, cost_paise: int, n=N_BOOT) -> tuple[float, float]:
    """95% CI on net incremental recovery, by resampling items."""
    idx = np.arange(len(df))
    vals = []
    for _ in range(n):
        take = rng.choice(idx, size=len(idx), replace=True)
        sub = df.iloc[take]
        vals.append(score(sub, fn(sub, cost_paise=cost_paise), cost_paise)["net_incremental_paise"])
    lo, hi = np.percentile(vals, [2.5, 97.5])
    return float(lo), float(hi)


def rupees(paise: float) -> str:
    return f"Rs {paise / 100:,.0f}"


def main() -> None:
    df = pd.read_csv(os.path.join(OUT_DIR, "risk_items.csv"))
    test = df[df.split == "test"].reset_index(drop=True)

    cost = DIRECT_COST_PAISE + DEFAULT_ANNOYANCE_PAISE

    print(f"\nheld-out test set: {len(test)} risk items, "
          f"{rupees(test.amount_paise.sum())} at risk")
    print(f"contact cost: {rupees(cost)} "
          f"({rupees(DIRECT_COST_PAISE)} direct + {rupees(DEFAULT_ANNOYANCE_PAISE)} patience)\n")

    results = {}
    for name, fn in POLICIES.items():
        contact = fn(test, cost_paise=cost)
        s = score(test, contact, cost)
        lo, hi = bootstrap_net(test, fn, cost)
        s["net_ci95_paise"] = [lo, hi]
        results[name] = s

    oracle_net = results["ORACLE"]["net_incremental_paise"]
    for name, s in results.items():
        s["pct_of_oracle"] = round(100 * s["net_incremental_paise"] / oracle_net, 1) if oracle_net else None

    print(f"{'policy':<20} {'contacts':>9} {'net incr.':>14} {'95% CI':>26} "
          f"{'%oracle':>8} {'wasted':>8}")
    print("-" * 92)
    for name, s in results.items():
        ci = f"[{rupees(s['net_ci95_paise'][0])}, {rupees(s['net_ci95_paise'][1])}]"
        print(f"{name:<20} {s['contacts']:>9} {rupees(s['net_incremental_paise']):>14} "
              f"{ci:>26} {str(s['pct_of_oracle']) + '%':>8} "
              f"{format(s['wasted_contact_rate'] * 100, '.1f') + '%':>8}")

    # ── Cost sweep ──────────────────────────────────────────────────────────
    # The honest framing: when contact is nearly free, chasing everything is
    # close to optimal and selectivity buys little. The value of choosing well
    # rises with what a contact actually costs. Rather than assert a number for
    # customer patience, we show the whole curve and let the reader pick.
    print("\ncost sweep — net incremental recovery by cost per contact")
    print(f"{'cost/contact':>14}  {'B1 contact-all':>16} {'B2 rules':>14} "
          f"{'ORACLE':>14}  {'oracle contacts':>16}")
    print("-" * 82)
    sweep = []
    for annoy in [0, 2_500, 10_000, 15_000, 30_000, 60_000, 120_000]:
        c = DIRECT_COST_PAISE + annoy
        row = {"cost_paise": c}
        for name, fn in POLICIES.items():
            row[name] = score(test, fn(test, cost_paise=c), c)["net_incremental_paise"]
        row["oracle_contacts"] = int(p_oracle(test, cost_paise=c).sum())
        sweep.append(row)
        print(f"{rupees(c):>14}  {rupees(row['B1_contact_all']):>16} "
              f"{rupees(row['B2_dunning_rules']):>14} {rupees(row['ORACLE']):>14}"
              f"  {row['oracle_contacts']:>16}")

    payload = dict(
        generated_at_seed=SEED,
        test_items=len(test),
        test_amount_at_risk_paise=int(test.amount_paise.sum()),
        contact_cost_paise=cost,
        direct_cost_paise=DIRECT_COST_PAISE,
        annoyance_cost_paise=DEFAULT_ANNOYANCE_PAISE,
        bootstrap_samples=N_BOOT,
        policies=results,
        cost_sweep=sweep,
        note=(
            "net_incremental = revenue(policy) - revenue(do-nothing) - contact spend. "
            "Only revenue above the do-nothing floor is claimable. ORACLE uses true "
            "uplift and is unachievable; it bounds the claim."
        ),
    )
    with open(os.path.join(OUT_DIR, "results.json"), "w") as f:
        json.dump(payload, f, indent=2)
    print(f"\nwrote {os.path.join(OUT_DIR, 'results.json')}\n")


if __name__ == "__main__":
    main()
