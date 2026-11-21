import { existsSync, readFileSync } from "node:fs";
import type { BacktestSummary } from "./backtest.ts";
import { reportPath } from "../reports.ts";
import { TOOL } from "../tool.ts";

/** The report a whole-repository backtest on a clean tree stores. It names the backtest, not `risk`. */
export const BACKTEST_REPORT = "risk-backtest";

export interface StoredBacktest {
  /** The commit the backtest ran at. */
  head: string;
  separation: BacktestSummary["separation"];
  population: BacktestSummary["population"];
  outcome: BacktestSummary["outcome"];
  levels: BacktestSummary["levels"];
  elevatedShare: number | null;
}

/**
 * The stored backtest, when it was made with the same configuration as this run: a different threshold
 * or pattern makes different bands, so its verdict would be about another model. A missing, unreadable
 * or foreign file is no backtest at all.
 */
export function readStoredBacktest(root: string, configHash: string): StoredBacktest | null {
  const file = reportPath(root, BACKTEST_REPORT);
  if (!existsSync(file)) return null;
  try {
    const document = JSON.parse(readFileSync(file, "utf8")) as {
      tool?: unknown;
      command?: unknown;
      config?: unknown;
      repo?: { head?: unknown };
      results?: Partial<BacktestSummary> & { kind?: unknown };
    };
    const results = document.results;
    if (document.tool !== TOOL || document.command !== BACKTEST_REPORT || document.config !== configHash) return null;
    if (typeof document.repo?.head !== "string" || results?.kind !== "backtest" || !results.separation) return null;
    return {
      head: document.repo.head,
      separation: results.separation,
      population: results.population!,
      outcome: results.outcome!,
      levels: results.levels!,
      elevatedShare: results.elevatedShare ?? null,
    };
  } catch {
    return null;
  }
}
