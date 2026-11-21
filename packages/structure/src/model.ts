import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { connectedPairs, measureActivity, type Activity } from "./activity.ts";
import type { LoadedHistory } from "./history-access.ts";
import { readLocalityUnblocks, type LocalityUnblocks } from "./locality-report.ts";
import { buildModuleGraph, type Level, type ModuleGraph } from "./modules.ts";
import { loadProject, type Project } from "./project.ts";
import { changeStability, structuralStability, type ChangeStability, type StructuralStability } from "./stability.ts";

/** Everything a command needs about one level: the code at the analysed commit, and what its history says. */
export interface Model {
  project: Project;
  graph: ModuleGraph;
  activity: Activity;
  structural: ReadonlyMap<string, StructuralStability>;
  change: ReadonlyMap<string, ChangeStability>;
  /** Locality's report when it is whole and matches the analysed commit, otherwise undefined. */
  locality: LocalityUnblocks | undefined;
}

export async function buildModel(context: CommandContext, history: LoadedHistory, level: Level, project?: Project): Promise<Model> {
  const { settings } = history;
  const loaded = project ?? (await loadProject(context.repo.root, history.view.headSha, settings.exclude));
  const graph = buildModuleGraph(level, loaded, settings.components);
  const activity = measureActivity(history.filtered.changes, graph, connectedPairs(graph));
  return {
    project: loaded,
    graph,
    activity,
    structural: structuralStability(loaded, graph),
    change: changeStability(graph, activity, settings),
    locality: readLocalityUnblocks(context, history.view.headSha),
  };
}
