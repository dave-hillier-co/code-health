import { SECONDS_PER_DAY } from "../units.ts";
import type { Outcome } from "./backtest.ts";
import { MIN_LEVEL_CHANGES } from "./backtest.ts";
import type { MergedChange } from "./merged-changes.ts";
import type { RiskSettings } from "./settings.ts";

export interface AdoptionWindow {
  /** Inclusive start, ISO 8601. */
  from: string;
  /** Exclusive end, ISO 8601. */
  to: string;
  /** Merged changes in the window whose follow-up window has run. */
  changes: number;
  /** Of those, reverted or followed by a fix to their files. */
  troubled: number;
  rate: number | null;
}

/** The follow-up fix rate of changes merged before and after the date the skill was adopted. */
export interface Adoption {
  adopted: string;
  /** The length of each window: the shorter of the history before the date and the history after it with a known outcome. */
  windowDays: number;
  before: AdoptionWindow;
  after: AdoptionWindow;
  /** After minus before, or null when either window has no changes. */
  difference: number | null;
  status: "lower" | "higher" | "unchanged" | "insufficient";
  reason: string;
}

const round = (value: number): number => Math.round(value * 10_000) / 10_000;
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

/**
 * Compares the trouble rate of changes merged in the window before `adopted` with the window of the same
 * length after it. The windows are the same length so that neither side has more time for a fix to arrive,
 * and the after window ends where outcomes stop being known (the follow-up window before the analysed
 * commit). Changes whose outcome is not yet known are left out of both. A direction is reported only when
 * each side holds enough changes to say.
 */
export function adoptionOf(
  all: readonly MergedChange[],
  outcomes: ReadonlyMap<string, Outcome>,
  adopted: number,
  risk: RiskSettings,
  headTime: number,
): Adoption {
  const knownUntil = headTime - risk.followUpDays * SECONDS_PER_DAY;
  const firstTime = all[0]?.time ?? adopted;
  const length = Math.max(0, Math.min(adopted - firstTime, knownUntil - adopted));
  const window = (from: number, to: number): AdoptionWindow => {
    const members = all.filter((change) => change.time >= from && change.time < to && outcomes.get(change.id)?.censored === false);
    const troubled = members.filter((change) => outcomes.get(change.id)!.reverted || outcomes.get(change.id)!.fixed).length;
    return { from: iso(from), to: iso(to), changes: members.length, troubled, rate: members.length === 0 ? null : round(troubled / members.length) };
  };
  const before = window(adopted - length, adopted);
  const after = window(adopted, adopted + length);
  const base = { adopted: iso(adopted), windowDays: round(length / SECONDS_PER_DAY), before, after };
  const thin = [before, after].find((side) => side.changes < MIN_LEVEL_CHANGES);
  if (thin !== undefined || before.rate === null || after.rate === null) {
    return {
      ...base,
      difference: before.rate === null || after.rate === null ? null : round(after.rate - before.rate),
      status: "insufficient",
      reason: `a window of ${base.windowDays} days either side of the date holds ${before.changes} changes before and ${after.changes} after with a known outcome, and each side needs at least ${MIN_LEVEL_CHANGES}`,
    };
  }
  const difference = round(after.rate - before.rate);
  const status = difference === 0 ? "unchanged" : difference < 0 ? "lower" : "higher";
  return {
    ...base,
    difference,
    status,
    reason: `${before.troubled} of ${before.changes} changes before and ${after.troubled} of ${after.changes} after were followed by trouble within ${risk.followUpDays} days, over ${base.windowDays} days either side. Other changes in practice over the same period are not controlled for.`,
  };
}
