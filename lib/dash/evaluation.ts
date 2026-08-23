import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { EvalResults } from "./rankers";

/**
 * Reads `eval/results.json` — the only source of any evaluation figure that
 * appears in this product. DECISIONS.md §2: no number reaches the UI that was
 * not produced by a committed run over the held-out set.
 *
 * This is deliberately a file read rather than a constant. If the file is
 * regenerated, the dashboard changes; if someone hand-edits a figure into a
 * component instead, it will not match this and the difference is visible.
 *
 * Shapes and ranker metadata live in `./rankers` precisely because this module
 * is server-only and the chart components need them on the client.
 */

let cached: EvalResults | null = null;

export async function getEvaluation(): Promise<EvalResults> {
  if (cached) return cached;
  const file = path.join(process.cwd(), "eval", "results.json");
  cached = JSON.parse(await readFile(file, "utf8")) as EvalResults;
  return cached;
}

export type {
  BudgetRow,
  ClassStat,
  EvalResults,
  RankerKey,
  Unconstrained,
} from "./rankers";
