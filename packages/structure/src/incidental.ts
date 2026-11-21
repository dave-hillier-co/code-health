import { existsSync } from "node:fs";
import { environmentError } from "@code-health/cli-kit/errors";
import { compareIds } from "@code-health/graph/graph";
import { measureRepo } from "@code-health/transcripts/measure-repo";
import { parseWindow } from "@code-health/transcripts/time-window";
import type { TaskEffort } from "@code-health/transcripts/agent-effort";
import type { CouplingRow } from "./coupling.ts";
import type { StructureSettings } from "./config.ts";
import { findCycles, unblocksOf } from "./cycles.ts";
import { layerRuleOf } from "./evidence-pack.ts";
import type { Model } from "./model.ts";

/**
 * Why an incidental pair matters beyond being entangled. Incidental coupling does not cost change effort
 * directly, so on its own it ranks low.
 */
export type IncidentalReason = "blocks-locality-move" | "in-cycle" | "layer-violation" | "agent-reads";

export interface IncidentalPriority {
  rank: "high" | "low";
  reasons: IncidentalReason[];
  /** Tasks that edited one side and opened the other only to follow the dependency. Null when no transcripts were read. */
  agentReads: number | null;
}

const day = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

/** The agent tasks of the analysis window, from Claude Code session transcripts. Paths and counts only. */
export function readAgentTasks(root: string, projectsDir: string, window: { since: number; until: number }): TaskEffort[] {
  if (!existsSync(projectsDir)) throw environmentError("no-projects-dir", `${projectsDir} does not exist`);
  const parsed = parseWindow(day(window.since), day(window.until + 86_400));
  return measureRepo({ projectsDir, repoRoots: [root], window: parsed }).tasks;
}

/** Tasks that edited files of one side and read files of the other side without editing them. */
export function agentReadsAcross(tasks: readonly TaskEffort[], from: readonly string[], to: readonly string[]): number {
  const sideFrom = new Set(from);
  const sideTo = new Set(to);
  const touches = (paths: readonly string[], side: ReadonlySet<string>): boolean => paths.some((path) => side.has(path));
  return tasks.filter((task) => {
    const editsFrom = touches(task.editedPaths, sideFrom);
    const editsTo = touches(task.editedPaths, sideTo);
    return (editsFrom && !editsTo && touches(task.readPaths, sideTo)) || (editsTo && !editsFrom && touches(task.readPaths, sideFrom));
  }).length;
}

/**
 * Ranks the incidental pairs of `rows` by what else they do: a pair ranks high when it blocks a locality move,
 * is part of a cycle, violates a layer rule, or burdens agents with reads (at least `minSupport` tasks). High pairs
 * come first, then those with more reasons, then the larger entanglements. Pairs of other quadrants are untouched.
 */
export function rankIncidental(
  rows: readonly CouplingRow[],
  model: Model,
  settings: Pick<StructureSettings, "exactLimit" | "layers" | "minSupport">,
  tasks: readonly TaskEffort[] | undefined,
): CouplingRow[] {
  const cycles = rows.some((row) => row.quadrant === "incidental") ? findCycles(model, settings) : [];
  const ranked = rows.map((row): CouplingRow => {
    if (row.quadrant !== "incidental") return row;
    const reasons: IncidentalReason[] = [];
    if (unblocksOf(model, row.from, row.to).length + unblocksOf(model, row.to, row.from).length > 0) reasons.push("blocks-locality-move");
    if (cycles.some((cycle) => cycle.nodes.includes(row.from) && cycle.nodes.includes(row.to))) reasons.push("in-cycle");
    if (layerRuleOf(model, row.from, row.to, settings) !== null || layerRuleOf(model, row.to, row.from, settings) !== null) reasons.push("layer-violation");
    const agentReads = tasks === undefined ? null : agentReadsAcross(tasks, model.graph.filesOf.get(row.from) ?? [], model.graph.filesOf.get(row.to) ?? []);
    if (agentReads !== null && agentReads >= settings.minSupport) reasons.push("agent-reads");
    return { ...row, incidental: { rank: reasons.length > 0 ? "high" : "low", reasons, agentReads } };
  });
  // `findCoupling` orders by quadrant, so the incidental rows are one run, and only they move.
  const start = ranked.findIndex((row) => row.quadrant === "incidental");
  if (start < 0) return ranked;
  const length = ranked.slice(start).findIndex((row) => row.quadrant !== "incidental");
  const stop = length < 0 ? ranked.length : start + length;
  const incidental = ranked.slice(start, stop).sort(
    (a, b) =>
      Number(b.incidental!.rank === "high") - Number(a.incidental!.rank === "high") ||
      b.incidental!.reasons.length - a.incidental!.reasons.length ||
      b.staticCoupling.sites - a.staticCoupling.sites ||
      compareIds(a.id, b.id),
  );
  return [...ranked.slice(0, start), ...incidental, ...ranked.slice(stop)];
}
