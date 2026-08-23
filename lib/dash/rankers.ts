/**
 * Evaluation shapes and ranker metadata.
 *
 * Deliberately free of `server-only` and of any Node import, because the chart
 * components are client components and need `RANKERS` as a *value*. Everything
 * that actually touches the filesystem stays in `evaluation.ts`.
 */

export interface BudgetRow {
  budget: number;
  random: number;
  by_amount: number;
  by_recovery_prob: number;
  dunning_rules: number;
  uplift_x_value: number;
}

export interface ClassStat {
  n: number;
  amount_at_risk_paise: number;
  mean_uplift: number;
  mean_self_recovery: number;
}

export interface Unconstrained {
  contacts: number;
  incremental_paise: number;
  net_incremental_paise: number;
  wasted_contacts: number;
  wasted_contact_rate: number;
  items: number;
}

export interface EvalResults {
  seed: number;
  test_items: number;
  test_amount_at_risk_paise: number;
  contact_cost_paise: number;
  headline_budget: number;
  by_class: Record<string, ClassStat>;
  budget_table: BudgetRow[];
  headline_lift_vs_amount_pct: number;
  headline_lift_vs_recovery_prob_pct: number;
  allocation_at_headline_budget: Record<string, Record<string, number>>;
  ci95_at_headline_budget: Record<string, [number, number]>;
  paired_diff_ci95: Record<
    string,
    { mean: number; lo: number; hi: number; excludes_zero: boolean }
  >;
  unconstrained: Record<string, Unconstrained>;
  compliance_blocked_items: number;
  compliance_blocked_paise: number;
  note: string;
}

export type RankerKey = keyof Omit<BudgetRow, "budget">;

/**
 * Fixed categorical assignment order. A hue belongs to a strategy permanently —
 * filtering or reordering the table must never repaint the survivors.
 *
 * `random` is the reference floor, drawn dashed in a neutral, which is why it
 * sits outside the validated four-hue categorical palette.
 */
export const RANKERS: {
  key: RankerKey;
  label: string;
  chart: string;
  ours: boolean;
  blurb: string;
}[] = [
  {
    key: "uplift_x_value",
    label: "Delta — uplift × value",
    chart: "var(--chart-1)",
    ours: true,
    blurb: "Ranks by expected incremental rupees.",
  },
  {
    key: "by_amount",
    label: "By ticket size",
    chart: "var(--chart-2)",
    ours: false,
    blurb: "Chase the biggest invoices first.",
  },
  {
    key: "by_recovery_prob",
    label: "By recovery probability",
    chart: "var(--chart-3)",
    ours: false,
    blurb: "Chase whoever is most likely to pay.",
  },
  {
    key: "dunning_rules",
    label: "Dunning ladder",
    chart: "var(--chart-4)",
    ours: false,
    blurb: "Fixed day 0 / 3 / 7 reminders.",
  },
  {
    key: "random",
    label: "Random",
    chart: "var(--chart-5)",
    ours: false,
    blurb: "Spend the budget arbitrarily — the floor.",
  },
];
