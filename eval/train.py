"""
Two-arm uplift model, exported for TypeScript scoring.

A T-learner: one calibrated model per arm (contacted / not contacted), with
uplift as the difference. Deliberately NOT a single P(recovery) classifier —
eval/results.json shows that ranking by recovery probability costs 66% of
achievable recovery, because it selects the customers most likely to pay anyway.

Logistic regression, not gradient boosting. The EV formula multiplies
probability by rupees, so calibration matters more than raw discrimination, and
per-feature contributions have to be explainable in the audit trail. Time-boxed
by DECISIONS.md §10.

Training happens here and never in production. The artefact is model.json,
scored by lib/uplift.ts in TypeScript — one runtime, no Python service.

    python eval/train.py
"""

from __future__ import annotations

import json
import math
import os

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_VERSION = "uplift-2arm-logreg-1"

NUMERIC = [
    "log_amount",
    "hours_since_event",
    "hour",
    "weekday",
    "days_to_payday",
    "downtime_active",
    "cust_success_count",
    "cust_failure_count",
    "log_tenure",
    "ltv_band",
    "prior_contacts_7d",
]

CATEGORICAL = {
    "risk_class": ["failed_payment", "abandoned_checkout", "overdue_receivable"],
    "taxonomy_class": [
        "TRANSIENT",
        "CUSTOMER_FIXABLE",
        "INSTRUMENT_DEAD",
        "DO_NOT_TOUCH",
        "OPAQUE",
        "ABANDONED",
        "RECEIVABLE",
    ],
    "method": ["card", "netbanking", "upi", "wallet", ""],
}


def build_features(df: pd.DataFrame) -> tuple[np.ndarray, list[str]]:
    """Must stay byte-for-byte equivalent to buildFeatures() in lib/uplift.ts."""
    d = df.copy()
    d["log_amount"] = np.log1p(d.amount_paise)
    d["log_tenure"] = np.log1p(d.cust_tenure_days)
    d["method"] = d.get("method", pd.Series([""] * len(d))).fillna("")
    d["taxonomy_class"] = d.taxonomy_class.fillna("")

    cols = list(NUMERIC)
    mat = [d[c].astype(float).to_numpy() for c in NUMERIC]

    for field, levels in CATEGORICAL.items():
        for lv in levels:
            cols.append(f"{field}={lv}")
            mat.append((d[field].astype(str) == lv).astype(float).to_numpy())

    return np.column_stack(mat), cols


def ece(y_true: np.ndarray, p: np.ndarray, bins: int = 10) -> float:
    """Expected calibration error — the metric that matters when EV multiplies by rupees."""
    edges = np.linspace(0, 1, bins + 1)
    total = 0.0
    for i in range(bins):
        m = (p >= edges[i]) & (p < edges[i + 1] if i < bins - 1 else p <= 1.0)
        if m.sum() == 0:
            continue
        total += (m.sum() / len(p)) * abs(y_true[m].mean() - p[m].mean())
    return float(total)


def fit_arm(Xtr, ytr, Xva, yva, rng) -> tuple[LogisticRegression, IsotonicRegression, dict]:
    """
    Calibration is fit on one half of validation and MEASURED on the other.

    Fitting isotonic and then scoring ECE on the same rows returns 0.0000 by
    construction — it interpolates its own training data. That number would be
    a lie, and calibration is precisely the property the EV formula depends on.
    """
    clf = LogisticRegression(max_iter=2000, C=1.0)
    clf.fit(Xtr, ytr)

    raw_va = clf.predict_proba(Xva)[:, 1]
    idx = rng.permutation(len(yva))
    half = len(idx) // 2
    fit_i, eval_i = idx[:half], idx[half:]

    # Platt scaling, not isotonic. With ~250 rows per arm in the calibration
    # half, isotonic overfits and made the control arm's ECE worse (0.058 ->
    # 0.090). A two-parameter sigmoid is the standard choice at this size, and
    # it ports to TypeScript as two floats rather than a knot table.
    eps = 1e-6
    lg = np.log(np.clip(raw_va[fit_i], eps, 1 - eps) / (1 - np.clip(raw_va[fit_i], eps, 1 - eps)))
    platt = LogisticRegression(max_iter=1000)
    platt.fit(lg.reshape(-1, 1), yva[fit_i])
    a = float(platt.coef_[0][0]); b = float(platt.intercept_[0])

    def apply_platt(r):
        r = np.clip(r, eps, 1 - eps)
        return 1 / (1 + np.exp(-(a * np.log(r / (1 - r)) + b)))

    metrics = dict(
        n_train=int(len(ytr)),
        n_val=int(len(yva)),
        base_rate=round(float(ytr.mean()), 4),
        auc_roc=round(float(roc_auc_score(yva, raw_va)), 4),
        auc_pr=round(float(average_precision_score(yva, raw_va)), 4),
        # Both measured on rows the calibrator never saw.
        ece_before=round(ece(yva[eval_i], raw_va[eval_i]), 4),
        ece_after=round(ece(yva[eval_i], apply_platt(raw_va[eval_i])), 4),
        calibration_note="Platt fit on half of validation, ECE measured on the other half",
    )
    return clf, (a, b), metrics


def main() -> None:
    df = pd.read_csv(os.path.join(OUT_DIR, "risk_items.csv"))
    df["taxonomy_class"] = df.taxonomy_class.fillna("")
    df["method"] = df.method.fillna("")

    train = df[df.split == "train"]
    val = df[df.split == "val"]

    Xtr_all, cols = build_features(train)
    Xva_all, _ = build_features(val)

    # Standardise on train only, so validation and test never leak into the scaler.
    mean = Xtr_all.mean(axis=0)
    scale = Xtr_all.std(axis=0)
    scale[scale == 0] = 1.0

    def z(X):
        return (X - mean) / scale

    rng = np.random.default_rng(20260823)
    arms = {}
    report = {}
    for arm_name, logged in (("control", 0), ("contact", 1)):
        tr = train.logged_action.to_numpy() == logged
        va = val.logged_action.to_numpy() == logged

        clf, (pa, pb), metrics = fit_arm(
            z(Xtr_all[tr]),
            train.y_observed.to_numpy()[tr],
            z(Xva_all[va]),
            val.y_observed.to_numpy()[va],
            rng,
        )
        report[arm_name] = metrics
        arms[arm_name] = dict(
            intercept=float(clf.intercept_[0]),
            coef=[float(c) for c in clf.coef_[0]],
            # Isotonic exported as knots; lib/uplift.ts interpolates linearly.
            calibration=dict(kind="platt", a=pa, b=pb),
        )
        print(f"{arm_name:>8}  n={metrics['n_train']:>5}  base={metrics['base_rate']:.3f}  "
              f"AUC-PR={metrics['auc_pr']:.3f}  ECE {metrics['ece_before']:.4f} -> {metrics['ece_after']:.4f}")

    model = dict(
        version=MODEL_VERSION,
        trained_on_rows=int(len(train)),
        feature_names=cols,
        numeric=NUMERIC,
        categorical=CATEGORICAL,
        scaler=dict(mean=[float(v) for v in mean], scale=[float(v) for v in scale]),
        arms=arms,
        metrics=report,
    )
    path = os.path.join(OUT_DIR, "model.json")
    with open(path, "w") as f:
        json.dump(model, f, indent=2)

    # Fixtures so the TypeScript port can be proven identical, not assumed so.
    sample = df[df.split == "test"].head(40)
    Xs = z(build_features(sample)[0])
    fixtures = []
    for i, (_, row) in enumerate(sample.iterrows()):
        preds = {}
        for arm_name in ("control", "contact"):
            a = arms[arm_name]
            logit = a["intercept"] + float(np.dot(Xs[i], a["coef"]))
            raw = min(max(1 / (1 + math.exp(-logit)), 1e-6), 1 - 1e-6)
            c = a["calibration"]
            preds[arm_name] = float(
                1 / (1 + math.exp(-(c["a"] * math.log(raw / (1 - raw)) + c["b"])))
            )
        fixtures.append(
            dict(
                input={k: (None if pd.isna(row[k]) else row[k])
                       for k in ["amount_paise", "risk_class", "taxonomy_class", "method",
                                 "hours_since_event", "hour", "weekday", "days_to_payday",
                                 "downtime_active", "cust_success_count", "cust_failure_count",
                                 "cust_tenure_days", "ltv_band", "prior_contacts_7d"]},
                p_control=preds["control"],
                p_contact=preds["contact"],
                uplift=preds["contact"] - preds["control"],
            )
        )
    with open(os.path.join(OUT_DIR, "fixtures.json"), "w") as f:
        json.dump(fixtures, f, indent=2, default=float)

    # How well does predicted uplift rank against true uplift? This, not AUC, is
    # what the budget policy actually depends on.
    test = df[df.split == "test"]
    Xt = z(build_features(test)[0])
    pred = {}
    for arm_name in ("control", "contact"):
        a = arms[arm_name]
        logits = a["intercept"] + Xt @ np.array(a["coef"])
        raw = np.clip(1 / (1 + np.exp(-logits)), 1e-6, 1 - 1e-6)
        c = a["calibration"]
        pred[arm_name] = 1 / (1 + np.exp(-(c["a"] * np.log(raw / (1 - raw)) + c["b"])))
    pred_uplift = pred["contact"] - pred["control"]
    corr = float(np.corrcoef(pred_uplift, test.true_uplift.to_numpy())[0, 1])
    print(f"\npredicted vs true uplift on held-out: pearson r = {corr:.3f}")
    print(f"wrote {path} and fixtures.json")


if __name__ == "__main__":
    main()
