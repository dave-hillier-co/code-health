import { compareIds } from "@code-health/graph/graph";
import { stronglyConnectedComponents } from "@code-health/graph/scc";
import { monthsBefore } from "@code-health/history/evidence";
import type { LogicalChange } from "@code-health/history/noise";
import type { TaskEffort } from "@code-health/transcripts/agent-effort";
import { summariseTasks, type EffortSummary } from "@code-health/transcripts/measure-repo";
import { measureActivity, type Activity } from "./activity.ts";
import type { StructureSettings } from "./config.ts";
import { couplingId, judgePair, type CoChangeJudgement, type Quadrant, type QuadrantJudgement, type StaticCoupling } from "./coupling.ts";
import { findLayerViolations } from "./layers.ts";
import { buildModuleGraph, type Level, type ModuleGraph } from "./modules.ts";
import type { Project } from "./project.ts";

type OutcomeSettings = Pick<StructureSettings, "minStaticCoupling" | "minSupport" | "minRevisions" | "significanceLevel" | "windowMonths" | "components" | "layers">;

/**
 * What became of the pair:
 *
 * - `broken`: the static coupling dropped and the co-change went with it.
 * - `hidden-not-broken`: the static coupling dropped and the co-change stayed. The dependency was
 *   hidden, not broken, and the remedy treated the symptom.
 * - `unchanged`: the co-change stayed and so did the static coupling.
 * - `co-change-reduced`: the co-change went but the static coupling did not drop.
 * - `no-baseline`: the pair did not co-change before the break, so there was nothing to reduce.
 * - `insufficient-evidence`: the co-change is gone, but a side was too quiet afterwards to say it was reduced and not just idle.
 */
export type Verdict = "broken" | "hidden-not-broken" | "unchanged" | "co-change-reduced" | "no-baseline" | "insufficient-evidence";

export interface OutcomeSide {
  quadrant: Quadrant;
  staticCoupling: StaticCoupling;
  coChange: CoChangeJudgement & {
    /** Percent of changes to `from` that also touched `to`. */
    confidenceFromTo: number;
    /** Percent of changes to `to` that also touched `from`. */
    confidenceToFrom: number;
  };
  bothActive: boolean;
}

export interface Span {
  since: string;
  until: string;
}

export interface Outcome {
  id: string;
  level: string;
  from: string;
  to: string;
  break: { rev: string; sha: string; parent: string; date: string };
  /** Two windows of the same length, either side of the break. The break's own change is in neither. */
  window: { before: Span; after: Span; seconds: number };
  before: OutcomeSide;
  after: OutcomeSide;
  verdict: Verdict;
  /** Leading indicators only: structure is cleaner, which says nothing about whether change got cheaper. */
  leading: {
    /** Import cycles between modules of the outcome's level, at the break's parent and at the analysed commit. */
    cycles: { before: number; after: number };
    /** Imports that break a configured layer rule. Null when no layers are configured. */
    layerViolations: { before: number; after: number } | null;
  };
  /**
   * Navigation did not get worse through indirection: agent effort on tasks that edited either side, over the
   * same two windows. Measured only when session transcripts were given.
   */
  agentEffort: { status: "measured"; before: EffortSummary; after: EffortSummary } | { status: "not-measured"; reason: string };
}

/** A pair that dropped its static dependency across the break and kept its co-change. */
export interface HiddenCreated {
  id: string;
  from: string;
  to: string;
  sitesBefore: number;
  sitesAfter: number;
  sharedBefore: number;
  sharedAfter: number;
  pValueAfter: number;
}

export interface BreakPoint {
  rev: string;
  sha: string;
  parent: string;
  /** Committer date of the break, unix seconds. */
  date: number;
  /** The analysed commit's date, unix seconds. */
  until: number;
}

export interface OutcomeInputs {
  level: Level;
  /** Modules at the analysed commit, and what its code says about them. */
  graphAfter: ModuleGraph;
  projectAfter: Project;
  /** The code at the break's parent. */
  projectBefore: Project;
  changes: readonly LogicalChange[];
  point: BreakPoint;
  settings: OutcomeSettings;
  /** The agent tasks of both windows, from session transcripts, or why there are none. */
  tasks: { tasks: readonly TaskEffort[] } | { reason: string };
}

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();
const round1 = (value: number): number => Math.round(value * 10) / 10;

function sideOf(judgement: QuadrantJudgement): OutcomeSide {
  const { shared, fromChanges, toChanges } = judgement.coChange;
  return {
    quadrant: judgement.name,
    staticCoupling: judgement.staticCoupling,
    coChange: {
      ...judgement.coChange,
      confidenceFromTo: fromChanges === 0 ? 0 : round1((shared / fromChanges) * 100),
      confidenceToFrom: toChanges === 0 ? 0 : round1((shared / toChanges) * 100),
    },
    bothActive: judgement.bothActive,
  };
}

export function verdictOf(before: OutcomeSide, after: OutcomeSide): Verdict {
  if (!before.coChange.high) return "no-baseline";
  const staticDropped = after.staticCoupling.sites < before.staticCoupling.sites;
  if (after.coChange.high) return staticDropped ? "hidden-not-broken" : "unchanged";
  if (!after.bothActive) return "insufficient-evidence";
  return staticDropped ? "broken" : "co-change-reduced";
}

/**
 * Whether a break made change cheaper, not merely whether the import went away: the co-change of
 * the pair over a window before the break and a window of the same length after it, and the static
 * coupling at the break's parent and at the analysed commit. The same is asked of every other pair
 * that lost its static dependency in between, as the check that indirection did not just hide it.
 * Both windows are as long as the history after the break allows, at most the analysis window.
 */
export function measureOutcome(inputs: OutcomeInputs, from: string, to: string): { outcome: Outcome; hiddenCreated: HiddenCreated[] } | undefined {
  const { point, settings, level } = inputs;
  const seconds = Math.min(point.date - monthsBefore(point.date, settings.windowMonths), point.until - point.date);
  if (seconds <= 0) return undefined;

  const outsideBreak = (change: LogicalChange) => !change.shas.includes(point.sha);
  const beforeChanges = inputs.changes.filter((c) => outsideBreak(c) && c.committerDate >= point.date - seconds && c.committerDate < point.date);
  const afterChanges = inputs.changes.filter((c) => outsideBreak(c) && c.committerDate >= point.date && c.committerDate <= point.date + seconds);

  const graphBefore = buildModuleGraph(level, inputs.projectBefore, settings.components);
  const dropped = droppedPairs(graphBefore, inputs.graphAfter);
  const wanted: [string, string][] = [[from, to], ...dropped];
  const activityBefore = measureActivity(beforeChanges, inputs.graphAfter, wanted);
  const activityAfter = measureActivity(afterChanges, inputs.graphAfter, wanted);

  const judge = (project: Project, graph: ModuleGraph, activity: Activity, a: string, b: string) => judgePair(project, graph, activity, a, b, settings);
  const before = sideOf(judge(inputs.projectBefore, graphBefore, activityBefore, from, to));
  const after = sideOf(judge(inputs.projectAfter, inputs.graphAfter, activityAfter, from, to));

  const hiddenCreated: HiddenCreated[] = [];
  for (const [a, b] of dropped) {
    const was = judge(inputs.projectBefore, graphBefore, activityBefore, a, b);
    const is = judge(inputs.projectAfter, inputs.graphAfter, activityAfter, a, b);
    if (!was.coChange.high || !is.coChange.high) continue;
    hiddenCreated.push({
      id: couplingId(level, a, b),
      from: a,
      to: b,
      sitesBefore: was.staticCoupling.sites,
      sitesAfter: is.staticCoupling.sites,
      sharedBefore: was.coChange.shared,
      sharedAfter: is.coChange.shared,
      pValueAfter: is.coChange.pValue,
    });
  }
  hiddenCreated.sort((x, y) => y.sharedAfter - x.sharedAfter || compareIds(x.id, y.id));

  const cycleCount = (graph: ModuleGraph): number => stronglyConnectedComponents(graph.graph).filter((component) => component.length > 1).length;
  const violations = (project: Project): number => findLayerViolations(project, settings.layers).length;
  const leading: Outcome["leading"] = {
    cycles: { before: cycleCount(graphBefore), after: cycleCount(inputs.graphAfter) },
    layerViolations: settings.layers.length === 0 ? null : { before: violations(inputs.projectBefore), after: violations(inputs.projectAfter) },
  };

  return {
    outcome: {
      id: `outcome:${level}:${from}->${to}`,
      level,
      from,
      to,
      break: { rev: point.rev, sha: point.sha, parent: point.parent, date: iso(point.date) },
      window: {
        before: { since: iso(point.date - seconds), until: iso(point.date) },
        after: { since: iso(point.date), until: iso(point.date + seconds) },
        seconds,
      },
      before,
      after,
      verdict: verdictOf(before, after),
      leading,
      agentEffort: agentEffortOf(inputs, graphBefore, from, to, seconds),
    },
    hiddenCreated,
  };
}

/**
 * The module pairs that depended on each other (either way) at the break's parent and no longer do
 * at the analysed commit, with both modules still present. Each pair is listed in the direction it was used more.
 */
function droppedPairs(before: ModuleGraph, after: ModuleGraph): [string, string][] {
  const pairs: [string, string][] = [];
  const seen = new Set<string>();
  for (const [from, targets] of before.graph) {
    for (const to of targets) {
      const key = from < to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!after.filesOf.has(from) || !after.filesOf.has(to)) continue;
      if (after.graph.get(from)?.includes(to) || after.graph.get(to)?.includes(from)) continue;
      pairs.push([from, to]);
    }
  }
  return pairs.sort((a, b) => compareIds(a[0], b[0]) || compareIds(a[1], b[1]));
}

/** Agent effort on the tasks that edited a file of either side, in the window before the break and the window after it. */
function agentEffortOf(inputs: OutcomeInputs, graphBefore: ModuleGraph, from: string, to: string, seconds: number): Outcome["agentEffort"] {
  if ("reason" in inputs.tasks) return { status: "not-measured", reason: inputs.tasks.reason };
  const { point } = inputs;
  const sides = new Set([from, to].flatMap((side) => [...(graphBefore.filesOf.get(side) ?? []), ...(inputs.graphAfter.filesOf.get(side) ?? [])]));
  const touching = inputs.tasks.tasks.filter((task) => task.editedPaths.some((path) => sides.has(path)));
  const within = (since: number, until: number) => touching.filter((task) => Date.parse(task.startedAt) >= since * 1000 && Date.parse(task.startedAt) < until * 1000);
  const before = within(point.date - seconds, point.date);
  const after = within(point.date, point.date + seconds);
  if (before.length === 0 && after.length === 0) return { status: "not-measured", reason: "no session in the windows edited either side" };
  return { status: "measured", before: summariseTasks(before), after: summariseTasks(after) };
}
