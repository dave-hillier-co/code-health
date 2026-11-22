import { levelOf, type Level } from "./level.ts";
import type { Assessed } from "./assess.ts";
import type { PlacementOutcome } from "./placement-result.ts";
import type { PlacementBand } from "./placement.ts";
import type { FactorBand } from "./scoring.ts";
import type { StoredBacktest } from "./stored-backtest.ts";

export interface LevelResult {
  /** `shown` only when a stored backtest of this configuration says the levels separate past changes. */
  status: "shown" | "withheld" | "unavailable";
  value: Level | null;
  impact: FactorBand;
  /** The placement band the level used: unknown when placement was withheld or off. */
  placement: PlacementBand;
  reason: string | null;
  /** The backtest the level stands on, stated beside it. */
  backtest: {
    head: string;
    commitsAgo: number | null;
    separation: StoredBacktest["separation"];
    elevatedShare: number | null;
    levels: StoredBacktest["levels"];
  } | null;
}

/**
 * The level, or the reason there is none. Until `cochange risk backtest` has run on the repository, with
 * this configuration, and shows that the levels separate past changes, the bands, findings and responses
 * stand alone: a level nobody has checked would only look like a measurement.
 */
export function levelResult(assessed: Assessed, placement: PlacementOutcome, stored: StoredBacktest | null, behind: number | null): LevelResult {
  const band: PlacementBand = placement.placement?.band ?? "unknown";
  const base = { impact: assessed.impact.band, placement: band };
  if (stored === null) {
    return { ...base, status: "unavailable", value: null, reason: "no stored backtest for this configuration, so no level is shown: a level is shown only where a stored backtest shows that the levels separate past changes", backtest: null };
  }
  const backtest = { head: stored.head, commitsAgo: behind, separation: stored.separation, elevatedShare: stored.elevatedShare, levels: stored.levels };
  if (stored.separation.status !== "separates") {
    return { ...base, status: "withheld", value: null, reason: `the backtest says the levels ${stored.separation.status === "insufficient" ? "cannot yet be shown to separate" : "do not separate"} past changes in this repository: ${stored.separation.reason}`, backtest };
  }
  const value = levelOf(assessed.impact.band, band);
  if (value === null) return { ...base, status: "unavailable", value: null, reason: "the impact could not be placed against enough merged changes", backtest };
  return { ...base, status: "shown", value, reason: null, backtest };
}
