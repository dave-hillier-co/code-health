import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { analyseProject, type AnalysisResult } from "./candidates.ts";
import type { LocalitySettings } from "./config.ts";
import { readHistory } from "./history-evidence.ts";
import { buildModel } from "./model.ts";
import { loadProject, type Project } from "./project.ts";

export interface UnitAnalysis {
  project: Project;
  analysis: AnalysisResult;
}

/** The analysis `locality analyse` makes of a revision, for the commands that act on one of its units. */
export async function analyseRevision(context: CommandContext, settings: LocalitySettings, ref: string): Promise<UnitAnalysis> {
  const project = await loadProject(context.repo.root, ref, settings);
  const history = settings.useHistory ? await readHistory(context, settings) : undefined;
  const model = buildModel(project, settings, history);
  return { project, analysis: analyseProject(project, model, settings, history) };
}
