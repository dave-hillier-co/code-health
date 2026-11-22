import type { Rule } from "@code-health/cli-kit/run-cli";
import { compareIds } from "@code-health/graph/graph";
import { folderDistance, folderOf } from "@code-health/graph/tree-distance";
import { compileGlobs } from "@code-health/history/glob";
import { isTestPath } from "@code-health/parse/languages";
import type { LocalitySettings } from "./config.ts";
import { bestTarget, type BoundaryEdge } from "./footprint.ts";
import { readAgainst, type GuidelineReading } from "./candidates.ts";
import { ageDays, isoDate, pairing, type History } from "./history-evidence.ts";

/** The most partners whose pairs are compared for independence: a unit with more is reviewed, not moved. */
const MAX_COMPARED_PARTNERS = 7;

export const historyRuleDescriptions: Record<string, Rule> = {
  "history-partners": {
    summary: "History only: the files that change with this unit sit elsewhere, so move it to them",
    explanation: [
      "No import graph was used. The unit's consumers are the files that change in the same logical changes: at least",
      "locality.historyMinSupport changes together, and at least locality.historyMinConfidence percent of the unit's",
      "changes also touch the partner. Each partner is weighted by its shared changes times that confidence. The target",
      "is the folder that minimises the weighted tree distance to the partners, as for structural candidates.",
      "",
      "Moves in this mode are made by the agent: there is no deterministic mover without an import graph, and no inline or split.",
      "Change spread cannot show the outcome, because the target minimises the distances spread measures.",
    ].join("\n"),
  },
  "history-independent-partners": {
    summary: "History only: two partners that rarely change with each other, so the coupling may be coincidence",
    explanation: [
      "The unit changes with two files, but those two files' median co-change degree is at or below locality.lowCoChange",
      "percent. Independent partners suggest coincidental reuse, so the move is a review.",
    ].join("\n"),
  },
  "history-many-partners": {
    summary: "History only: three or more partners that do not change together, so judge before moving",
    explanation: [
      "Three or more files change with the unit and not with each other. At the third consumer the rule of three asks for",
      "judgement: consider whether they share a reason to change. Partners that do change together earn the distance and",
      "are left out of the list.",
    ].join("\n"),
  },
  "history-within-grace-period": {
    summary: "History only: a unit younger than locality.graceDays is not moved",
    explanation: [
      "The youngest file of the unit first appeared fewer than locality.graceDays days before HEAD, so co-change so far is",
      "little evidence. Re-run once it has aged.",
    ].join("\n"),
  },
};

export interface Partner {
  path: string;
  /** Logical changes touching the unit and the partner. */
  support: number;
  /** Percent of the unit's changes that also touch the partner. */
  confidence: number;
  /** What the partner counts for in net distance: its shared changes times its confidence, at least 1. */
  weight: number;
}

export interface HistoryCandidate {
  path: string;
  score: number;
  recommendation: "move" | "review";
  rule: string;
  source: "history";
  /** The gain beside the `minDistance` guideline. */
  guidelines: { gain: GuidelineReading };
  /**
   * Candidates left out because their files are partners of this one and the pull towards this candidate is the
   * stronger (higher gain, then path order). Moving it and moving them would be one question asked twice.
   */
  supersedes: Array<{ path: string; gain: number }>;
  unit: { kind: "file" | "cluster"; root: string; files: string[] };
  location: string;
  target: string;
  distance: number;
  gain: number;
  netDistance: { current: number; atTarget: number };
  /** The partners standing in for consumers. */
  consumers: Partner[];
  fanIn: number;
  /** The median co-change degree between pairs of partners, null when there are fewer than two or too few changes. */
  amongConsumers: number | null;
  age: number | null;
  lastChanged: string | null;
  churn: number;
}

export type Omission = "earned-distance" | "fixed-point" | "near-partners" | "superseded";

export interface HistoryOnlyResult {
  candidates: HistoryCandidate[];
  /** Why files that history alone would have considered were not reported. */
  omitted: Record<Omission, number>;
  /** Set when the evidence is too weak to report anything. */
  reason: string | null;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : round1((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** Files that change in the same logical changes as the group, with how often. */
function partnersOf(history: History, group: ReadonlySet<string>, present: ReadonlySet<string>, settings: LocalitySettings): Partner[] {
  const touching = new Set<number>();
  for (const member of group) for (const index of history.changesOf.get(member) ?? []) touching.add(index);
  const counts = new Map<string, number>();
  for (const index of touching) {
    for (const file of history.changes[index]!) {
      if (group.has(file) || !present.has(file) || isTestPath(file)) continue;
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  const partners: Partner[] = [];
  for (const [path, support] of counts) {
    const confidence = (100 * support) / touching.size;
    if (support < settings.historyMinSupport || confidence < settings.historyMinConfidence) continue;
    partners.push({ path, support, confidence: round1(confidence), weight: Math.max(1, Math.round((support * confidence) / 100)) });
  }
  return partners.sort((a, b) => b.weight - a.weight || compareIds(a.path, b.path));
}

/** Connected groups of files in one folder whose pairs each change together at least `highCoChange` percent of the time. */
function clusters(history: History, present: ReadonlySet<string>, settings: LocalitySettings): string[][] {
  const byFolder = new Map<string, string[]>();
  for (const file of [...history.changesOf.keys()].sort(compareIds)) {
    if (!present.has(file) || isTestPath(file)) continue;
    byFolder.set(folderOf(file), [...(byFolder.get(folderOf(file)) ?? []), file]);
  }
  const result: string[][] = [];
  for (const files of byFolder.values()) {
    const parent = new Map(files.map((file) => [file, file]));
    const find = (file: string): string => (parent.get(file) === file ? file : find(parent.get(file)!));
    for (const [index, a] of files.entries()) {
      for (const b of files.slice(index + 1)) {
        const paired = pairing(history, new Set([a]), b);
        if (paired.support >= settings.historyMinSupport && paired.degree >= settings.highCoChange) parent.set(find(b), find(a));
      }
    }
    const groups = new Map<string, string[]>();
    for (const file of files) groups.set(find(file), [...(groups.get(find(file)) ?? []), file]);
    for (const group of groups.values()) if (group.length > 1) result.push(group);
  }
  return result;
}

/**
 * The language-agnostic analysis: a file's consumers are its co-change partners, and units are single files or
 * clusters of files in one folder that change together. Nothing here reads the import graph, so nothing here
 * inlines or splits. It reports only on moderate or strong evidence, and otherwise says why it reports nothing.
 */
export function analyseByHistory(history: History, files: ReadonlySet<string>, settings: LocalitySettings): HistoryOnlyResult {
  const omitted: Record<Omission, number> = { "earned-distance": 0, "fixed-point": 0, "near-partners": 0, superseded: 0 };
  if (history.evidence.grade === "weak") {
    return {
      candidates: [],
      omitted,
      reason: `history is weak (${history.evidence.usableHistoryMonths} months, ${history.evidence.logicalChangesInWindow} logical changes in the window, ${history.evidence.activeContributors} contributors); history-only candidates need moderate or strong evidence`,
    };
  }
  const present = new Set([...files].filter((file) => history.changesOf.has(file)));
  const isFixed = compileGlobs(settings.fixedPoints);
  const forbidden = (folder: string) => settings.fixedPoints.length > 0 && isFixed(folder === "" ? "_" : `${folder}/_`);

  const grouped = clusters(history, present, settings);
  const inCluster = new Set(grouped.flat());
  const units = [...grouped, ...[...present].filter((file) => !inCluster.has(file) && !isTestPath(file)).map((file) => [file])]
    .map((group) => [...group].sort(compareIds))
    .sort((a, b) => compareIds(a[0]!, b[0]!));

  const candidates: HistoryCandidate[] = [];
  for (const unitFiles of units) {
    const group = new Set(unitFiles);
    const partners = partnersOf(history, group, present, settings);
    if (partners.length === 0) continue;
    const root = unitFiles[0]!;
    if (unitFiles.some((file) => isFixed(file))) {
      omitted["fixed-point"]++;
      continue;
    }
    const base = folderOf(root);
    const edges: BoundaryEdge[] = partners.map((partner) => ({ inner: "", outer: folderOf(partner.path), weight: partner.weight }));
    // A cluster sits in one folder, so every member is at the base and the edges are the same as for a file.
    const choice = bestTarget(edges, base, { maxDepth: settings.maxDepth, forbidden });
    if (choice.gain < settings.minDistance) {
      omitted["near-partners"]++;
      continue;
    }

    let among: number | null = null;
    if (partners.length >= 2 && partners.length <= MAX_COMPARED_PARTNERS) {
      const touching = new Set(partners.flatMap((partner) => history.changesOf.get(partner.path) ?? []));
      if (touching.size >= settings.minCoChangeChanges) {
        const degrees: number[] = [];
        for (const [index, a] of partners.entries()) {
          for (const b of partners.slice(index + 1)) degrees.push(pairing(history, new Set([a.path]), b.path).degree);
        }
        among = median(degrees);
      }
    }
    const ages = unitFiles.map((file) => ageDays(history, file)).filter((age): age is number => age !== null);
    const age = ages.length === 0 ? null : Math.min(...ages);

    let decision: { recommendation: "move" | "review"; rule: string };
    if (age !== null && age < settings.graceDays) decision = { recommendation: "review", rule: "history-within-grace-period" };
    else if (partners.length >= 3) {
      if (among !== null && among >= settings.highCoChange) {
        omitted["earned-distance"]++;
        continue;
      }
      decision = { recommendation: "review", rule: "history-many-partners" };
    } else if (partners.length === 2 && among !== null && among <= settings.lowCoChange) {
      decision = { recommendation: "review", rule: "history-independent-partners" };
    } else decision = { recommendation: "move", rule: "history-partners" };

    const dates = unitFiles.flatMap((file) => history.lastChanged.get(file) ?? []);
    candidates.push({
      path: root,
      score: choice.gain,
      ...decision,
      source: "history",
      guidelines: { gain: readAgainst(choice.gain, settings.minDistance) },
      supersedes: [],
      unit: { kind: unitFiles.length === 1 ? "file" : "cluster", root, files: unitFiles },
      location: base,
      target: choice.target,
      distance: folderDistance(base, choice.target),
      gain: choice.gain,
      netDistance: { current: choice.current, atTarget: choice.distance },
      consumers: partners,
      fanIn: partners.length,
      amongConsumers: among,
      age,
      lastChanged: dates.length === 0 ? null : isoDate(Math.max(...dates)),
      churn: unitFiles.reduce((sum, file) => sum + (history.churn.get(file) ?? 0), 0),
    });
  }
  candidates.sort((a, b) => b.score - a.score || compareIds(a.path, b.path));
  // Files that always change together pull on each other: a file moving to its partners and the partners moving
  // to the file are one question asked twice. The stronger pull is kept, and the other is left out.
  const claimedBy = new Map<string, HistoryCandidate>();
  const kept: HistoryCandidate[] = [];
  for (const candidate of candidates) {
    const winner = candidate.unit.files.map((file) => claimedBy.get(file)).find((other) => other !== undefined);
    if (winner !== undefined) {
      omitted.superseded++;
      winner.supersedes.push({ path: candidate.path, gain: candidate.gain });
      continue;
    }
    kept.push(candidate);
    for (const partner of candidate.consumers) if (!claimedBy.has(partner.path)) claimedBy.set(partner.path, candidate);
  }
  return { candidates: kept, omitted, reason: null };
}
