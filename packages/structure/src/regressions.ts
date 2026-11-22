import { environmentError, usageError } from "@code-health/cli-kit/errors";
import { breakingSets } from "@code-health/graph/feedback-arc-set";
import { runGit } from "@code-health/history/git";
import type { StructureSettings } from "./config.ts";
import { findLayerViolations, type LayerViolation } from "./layers.ts";
import { buildModuleGraph, importGraph, type Level } from "./modules.ts";
import { loadProject, type Project } from "./project.ts";

export const CHECK_LEVELS: readonly Level[] = ["default", "file", "folder", "package"];

/** The levels `check` runs when none is named: `file` is left out because `default` is the file level for every language that has no coarser one. */
export const DEFAULT_CHECK_LEVELS: readonly Level[] = ["default", "folder", "package"];

export interface CycleSnapshot {
  id: string;
  level: Level;
  nodes: string[];
  /** The edges of the minimum breaking set: the smallest cut that would break the cycle. */
  breakingSet: { from: string; to: string }[];
}

/** What the structure of one commit holds that `check` judges. */
export interface StructureSnapshot {
  sha: string;
  cycles: CycleSnapshot[];
  layerViolations: LayerViolation[];
}

const commitOf = async (root: string, rev: string): Promise<string | undefined> => {
  try {
    return (await runGit(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])).trim() || undefined;
  } catch {
    return undefined;
  }
};

/** The commit of a revision the user named, or a usage error. */
export async function resolveRevision(root: string, rev: string): Promise<string> {
  const sha = await commitOf(root, rev);
  if (sha === undefined) throw usageError(`"${rev}" is not a revision of this repository`);
  return sha;
}

/**
 * The commit `check` compares against: `--base`, else the configured `base`, else the merge base of
 * the analysed commit with the main branch (or its `origin/` counterpart).
 */
export async function resolveBase(root: string, headSha: string, settings: Pick<StructureSettings, "base" | "mainBranch">, flag: string | undefined): Promise<{ rev: string; sha: string }> {
  const explicit = flag ?? settings.base;
  if (explicit !== null && explicit !== undefined) return { rev: explicit, sha: await resolveRevision(root, explicit) };
  for (const candidate of [settings.mainBranch, `origin/${settings.mainBranch}`]) {
    if ((await commitOf(root, candidate)) === undefined) continue;
    try {
      const sha = (await runGit(root, ["merge-base", headSha, candidate])).trim();
      return { rev: candidate, sha };
    } catch {
      // no common ancestor with this candidate
    }
  }
  throw environmentError(
    "no-base",
    `cannot find the merge base with "${settings.mainBranch}": there is no such branch, or it shares no history with the analysed commit; pass --base REV`,
  );
}

function cyclesOf(project: Project, level: Level, settings: Pick<StructureSettings, "exactLimit" | "components">): CycleSnapshot[] {
  const graph = buildModuleGraph(level, project, settings.components);
  return breakingSets(importGraph(graph), { exactLimit: settings.exactLimit }).map((cycle) => ({
    id: `cycle:${level}:${cycle.nodes[0]}`,
    level,
    nodes: [...cycle.nodes],
    breakingSet: cycle.edges.map((e) => ({ from: e.from, to: e.to })),
  }));
}

/** A cycle that has the same nodes as one of an earlier level (Go packages are folders and packages too) is listed once, at the first. */
function withoutRepeats(cycles: CycleSnapshot[]): CycleSnapshot[] {
  const seen = new Set<string>();
  return cycles.filter((cycle) => {
    const key = [...cycle.nodes].sort().join("\n");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The cycles at the chosen levels and the layer violations of one commit. */
export async function snapshotOf(root: string, sha: string, levels: readonly Level[], settings: StructureSettings): Promise<StructureSnapshot> {
  const project = await loadProject(root, sha, settings);
  return {
    sha,
    cycles: withoutRepeats(levels.flatMap((level) => cyclesOf(project, level, settings))),
    layerViolations: findLayerViolations(project, settings.layers),
  };
}

export interface NewSince {
  cycles: CycleSnapshot[];
  layerViolations: LayerViolation[];
}

/**
 * What the head has that the base did not. A cycle is new unless all its nodes sat inside one
 * cycle of the base (so a cycle that only shrank is not new, and one that took in another module is).
 * A layer violation is new unless the same import violated the rules at the base.
 */
export function newSince(base: StructureSnapshot, head: StructureSnapshot): NewSince {
  const existed = (cycle: CycleSnapshot) =>
    base.cycles.some((b) => b.level === cycle.level && cycle.nodes.every((node) => b.nodes.includes(node)));
  const knownViolations = new Set(base.layerViolations.map((v) => v.id));
  return {
    cycles: head.cycles.filter((cycle) => !existed(cycle)),
    layerViolations: head.layerViolations.filter((v) => !knownViolations.has(v.id)),
  };
}
