import { checkFixConvention, fixEvidence, type FixConvention, type FixEvidence } from "@code-health/history/fix-commits";
import { monthsBefore } from "@code-health/history/evidence";
import { runGit } from "@code-health/history/git";
import { SECONDS_PER_DAY } from "../units.ts";
import { chronologicalPass, fixOf, type PastChange } from "./history-pass.ts";
import { levelOf, LEVELS, type Level } from "./level.ts";
import type { MeasureContext } from "./measure.ts";
import type { MergedChange } from "./merged-changes.ts";
import type { PlacementBand } from "./placement.ts";
import { baselineScores, impactOf, makeBander, SCORED_FACTORS, type FactorBand, type ImpactResult } from "./scoring.ts";
import type { RiskSettings } from "./settings.ts";

/** A past change as it would have been scored the day it merged. */
export interface ScoredChange {
  index: number;
  change: MergedChange;
  /** Each factor's band as of the change, `unavailable` when it could not be placed. */
  bands: Map<string, FactorBand>;
  impact: ImpactResult;
  placement: PlacementBand;
  level: Level | null;
  /** The baseline it was compared with: how many earlier merged changes. */
  baseline: number;
  missing: { file: string }[];
}

export interface ScoreOptions {
  windowMonths: number;
  maxChangesetSize: number;
  /** Score only changes at or after this time (unix seconds). Earlier ones still feed the history. */
  since?: number;
}

/**
 * Scores every change as of itself: its factors, bands and level come from the history before it
 * and from nothing else. The baseline of a change is the merged changes that came before it, within
 * the window, each measured as of its own time. Scoring a change with today's figures would leak
 * the outcome, since a file that was fixed later is a hotspot now.
 */
export function scoreMainline(changes: readonly MergedChange[], context: MeasureContext, options: ScoreOptions): ScoredChange[] {
  const { risk } = context;
  const { past } = chronologicalPass(changes, context, {
    windowMonths: options.windowMonths,
    maxChangesetSize: options.maxChangesetSize,
    fix: risk.fix,
    placement: true,
  });
  const scored: ScoredChange[] = [];
  for (const [at, entry] of past.entries()) {
    if (options.since !== undefined && entry.change.time < options.since) continue;
    const since = monthsBefore(entry.change.time, options.windowMonths);
    const baseline = past.slice(Math.max(0, at - risk.baselineChanges), at).filter((p) => p.change.time >= since);
    scored.push(scoreOne(at, entry, baseline, risk));
  }
  return scored;
}

function scoreOne(index: number, entry: PastChange, baseline: readonly PastChange[], risk: RiskSettings): ScoredChange {
  const measures = baseline.map((p) => p.measurements);
  const bander = makeBander(measures, risk);
  const bands = new Map<string, FactorBand>();
  const factors = entry.measurements.map((m) => {
    const band = risk.disabled.has(m.name) ? "unavailable" : bander(m).band;
    bands.set(m.name, band);
    return { name: m.name, family: m.family, band, disabled: risk.disabled.has(m.name) };
  });
  const events: string[] = [];
  if (bands.get("missing-co-change") === "high") events.push("missing-co-change");
  if (!risk.disabled.has("sensitive-paths") && Number(entry.measurements.find((m) => m.name === "sensitive-paths")?.series.count ?? 0) > 0) {
    events.push("sensitive-paths");
  }
  const impact = impactOf(factors, baselineScores(measures, risk), events, risk);
  const placement = entry.placement?.band ?? "unknown";
  const missing = (entry.measurements.find((m) => m.name === "missing-co-change")?.evidence ?? []).map((row) => ({ file: String(row.file) }));
  return { index, change: entry.change, bands, impact, placement, level: levelOf(impact.band, placement), baseline: baseline.length, missing };
}

export interface Outcome {
  /** The change was reverted by a later commit that names one of its commits. */
  reverted: boolean;
  /** A fix change touched its files within the follow-up window after it. */
  fixed: boolean;
  /** The follow-up window runs past the analysed commit, so the outcome is not yet known. */
  censored: boolean;
}

/** SHAs named by `This reverts commit <sha>`, in the commits reachable from `tip`. */
async function revertedShas(root: string, tip: string): Promise<Map<string, string[]>> {
  const out = await runGit(root, ["log", "--grep=This reverts commit", "--format=%H%x1f%B%x1e", tip]);
  const reverts = new Map<string, string[]>();
  for (const entry of out.split("\x1e")) {
    const [sha, ...body] = entry.replace(/^\n/, "").split("\x1f");
    if (!sha) continue;
    for (const match of body.join("\x1f").matchAll(/This reverts commit ([0-9a-f]{40})/g)) {
      const list = reverts.get(match[1]!);
      if (list) list.push(sha.trim());
      else reverts.set(match[1]!, [sha.trim()]);
    }
  }
  return reverts;
}

/**
 * What became of each change: reverted, or followed by a fix to its files within the window. Found by
 * the commit-message convention and by the revert trailer. The file-level test over-counts in busy
 * files, which is why each level's rate is read against the rate of the same files.
 */
export async function outcomesOf(
  root: string,
  tip: string,
  changes: readonly MergedChange[],
  risk: RiskSettings,
  headTime: number,
): Promise<Map<string, Outcome>> {
  const reverts = await revertedShas(root, tip);
  const unitOfCommit = new Map<string, number>();
  for (const [index, change] of changes.entries()) {
    unitOfCommit.set(change.id, index);
    for (const sha of change.shas) unitOfCommit.set(sha, index);
  }
  const reverted = new Set<number>();
  for (const [sha, by] of reverts) {
    const target = unitOfCommit.get(sha);
    if (target === undefined) continue;
    // The reverting commit has to be a later change. A revert inside the change itself is not trouble.
    if (by.some((revert) => (unitOfCommit.get(revert) ?? -1) > target)) reverted.add(target);
  }

  const touching = new Map<string, number[]>();
  for (const [index, change] of changes.entries()) {
    for (const file of change.files) {
      const list = touching.get(file.fileId);
      if (list) list.push(index);
      else touching.set(file.fileId, [index]);
    }
  }
  const window = risk.followUpDays * SECONDS_PER_DAY;
  const fix = changes.map((change) => fixOf(change, risk.fix) !== null);
  const outcomes = new Map<string, Outcome>();
  for (const [index, change] of changes.entries()) {
    let fixed = false;
    for (const file of change.files) {
      for (const later of touching.get(file.fileId) ?? []) {
        if (later <= index) continue;
        if (changes[later]!.time > change.time + window) break;
        if (fix[later]) fixed = true;
      }
      if (fixed) break;
    }
    outcomes.set(change.id, { reverted: reverted.has(index), fixed, censored: change.time + window > headTime });
  }
  return outcomes;
}

export interface BandRow {
  band: string;
  changes: number;
  troubled: number;
  /** Troubled over changes, or null when there are none. */
  rate: number | null;
  /** The same rate over the files these changes touched: the rate to beat. */
  baseRate: number | null;
}

const round = (value: number): number => Math.round(value * 10_000) / 10_000;

export interface FactorRow {
  name: string;
  bands: BandRow[];
  unavailable: number;
}

export interface BacktestSummary {
  population: { mergedChanges: number; scored: number; withLevel: number; censored: number; unscored: number };
  outcome: { followUpDays: number; fixConvention: FixConvention; fixes: FixEvidence; reverts: number; troubled: number; rate: number | null };
  levels: BandRow[];
  impact: BandRow[];
  placement: BandRow[];
  factors: FactorRow[];
  completeness: { findings: number; followed: number; share: number | null };
  elevatedShare: number | null;
  separation: { status: "separates" | "does-not-separate" | "insufficient"; reason: string };
}

export const MIN_LEVEL_CHANGES = 5;
export const MIN_TROUBLED = 3;

/** Does the rate rise with the level? Judged on the levels with enough changes to say. */
export function separationOf(levels: readonly BandRow[], troubled: number): BacktestSummary["separation"] {
  const usable = levels.filter((row) => row.changes >= MIN_LEVEL_CHANGES && row.rate !== null);
  if (troubled < MIN_TROUBLED) {
    return { status: "insufficient", reason: `only ${troubled} past changes were followed by trouble, fewer than the ${MIN_TROUBLED} needed to compare levels` };
  }
  if (usable.length < 2) {
    return { status: "insufficient", reason: `fewer than two levels have at least ${MIN_LEVEL_CHANGES} changes to compare` };
  }
  const rates = usable.map((row) => row.rate!);
  const rises = rates.every((rate, i) => i === 0 || rate >= rates[i - 1]!) && rates.at(-1)! > rates[0]!;
  const last = usable.at(-1)!;
  const beatsBase = last.baseRate === null || last.rate! > last.baseRate;
  return rises && beatsBase
    ? { status: "separates", reason: `the trouble rate rises from ${usable[0]!.rate} at ${usable[0]!.band} to ${last.rate} at ${last.band}, above the ${last.baseRate} of the same files` }
    : { status: "does-not-separate", reason: `the trouble rate does not rise with the level (${usable.map((row) => `${row.band} ${row.rate}`).join(", ")}) or does not beat the rate of the same files` };
}

/**
 * Tabulates the scored changes against what became of them. Reports per level and per factor band, never
 * per person: no author appears anywhere in it.
 */
export function summarise(
  scored: readonly ScoredChange[],
  all: readonly MergedChange[],
  outcomes: ReadonlyMap<string, Outcome>,
  risk: RiskSettings,
): BacktestSummary {
  const known = scored.filter((s) => outcomes.get(s.change.id)?.censored === false);
  const troubledOf = (s: ScoredChange): boolean => {
    const o = outcomes.get(s.change.id)!;
    return o.reverted || o.fixed;
  };

  // The rate of the same files: over every change with a known outcome, each file's share that met trouble.
  const perFile = new Map<string, { changes: number; troubled: number }>();
  for (const change of all) {
    const outcome = outcomes.get(change.id);
    if (!outcome || outcome.censored) continue;
    const trouble = outcome.reverted || outcome.fixed;
    for (const file of change.files) {
      const row = perFile.get(file.fileId) ?? { changes: 0, troubled: 0 };
      row.changes++;
      if (trouble) row.troubled++;
      perFile.set(file.fileId, row);
    }
  }
  const baseOf = (s: ScoredChange): number | null => {
    let changes = 0;
    let troubled = 0;
    for (const file of s.change.files) {
      const row = perFile.get(file.fileId);
      if (row) {
        changes += row.changes;
        troubled += row.troubled;
      }
    }
    return changes === 0 ? null : troubled / changes;
  };

  const rows = (keys: readonly string[], keyOf: (s: ScoredChange) => string | null): BandRow[] =>
    keys.map((band) => {
      const members = known.filter((s) => keyOf(s) === band);
      const troubled = members.filter(troubledOf).length;
      const bases = members.map(baseOf).filter((b): b is number => b !== null);
      return {
        band,
        changes: members.length,
        troubled,
        rate: members.length === 0 ? null : round(troubled / members.length),
        baseRate: bases.length === 0 ? null : round(bases.reduce((a, b) => a + b, 0) / bases.length),
      };
    });

  const levels = rows(LEVELS, (s) => s.level);
  const factors: FactorRow[] = [...SCORED_FACTORS].map((name) => ({
    name,
    bands: rows(["low", "moderate", "high"], (s) => {
      const band = s.bands.get(name);
      return band === undefined || band === "unavailable" ? null : band;
    }),
    unavailable: known.filter((s) => (s.bands.get(name) ?? "unavailable") === "unavailable").length,
  }));

  const outcomeList = [...outcomes.values()];
  const troubled = known.filter(troubledOf).length;
  const withFinding = scored.filter((s) => s.missing.length > 0);
  const followed = withFinding.filter((s) => {
    const until = s.change.time + risk.followUpDays * SECONDS_PER_DAY;
    for (const later of all.slice(s.index + 1)) {
      if (later.time > until) break;
      if (later.files.some((f) => s.missing.some((m) => m.file === f.fileId))) return true;
    }
    return false;
  }).length;
  const withLevel = scored.filter((s) => s.level !== null);

  const fixMatches = all.flatMap((change) => fixOf(change, risk.fix) ?? []);
  return {
    population: {
      mergedChanges: all.length,
      scored: scored.length,
      withLevel: withLevel.length,
      censored: scored.filter((s) => outcomes.get(s.change.id)?.censored).length,
      unscored: all.length - scored.length,
    },
    outcome: {
      followUpDays: risk.followUpDays,
      fixConvention: checkFixConvention(all.length, fixMatches.length),
      fixes: fixEvidence(fixMatches),
      reverts: outcomeList.filter((o) => o.reverted).length,
      troubled,
      rate: known.length === 0 ? null : round(troubled / known.length),
    },
    levels,
    impact: rows(["low", "moderate", "high"], (s) => (s.impact.band === "unavailable" ? null : s.impact.band)),
    placement: rows(["close", "mixed", "distant", "unknown"], (s) => s.placement),
    factors,
    completeness: { findings: withFinding.length, followed, share: withFinding.length === 0 ? null : round(followed / withFinding.length) },
    elevatedShare: withLevel.length === 0 ? null : round(withLevel.filter((s) => s.level === "elevated").length / withLevel.length),
    separation: separationOf(levels, troubled),
  };
}
