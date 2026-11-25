import type { CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { historySections, identityStamps } from "../analysis-command.ts";
import { loadHistory, type LoadedHistory } from "../history-access.ts";
import { overridesExposure } from "./overrides-exposure.ts";
import { loadKnowledge, type LoadedKnowledge } from "./load.ts";
import { noticesSection, readMappedShare } from "./notices.ts";
import { requireKnowledge, type KnowledgeSettings } from "./settings.ts";

/** What every subcommand of the abandonment analysis starts from. */
export interface Prepared {
  context: CommandContext;
  settings: KnowledgeSettings;
  history: LoadedHistory;
  knowledge: LoadedKnowledge;
  /** The blame cache was not refreshed, so files it holds nothing right for are unknown. */
  noRefresh: boolean;
  /** Printed with the results: the mapped share is under its guideline. */
  notices: string[];
  /** The mapped share, as a percentage, when it is under its guideline; otherwise null. */
  mappedShareUnder: number | null;
}

/**
 * Checks the privacy gate, then loads history and the knowledge model. Both caches are
 * refreshed first unless `--no-refresh` is given, as every analysis does.
 */
export async function prepare(context: CommandContext): Promise<Prepared> {
  const settings = requireKnowledge(context);
  const noRefresh = context.values["no-refresh"] === true;
  const exposure = await overridesExposure(context.repo.root);
  if (exposure !== null) process.stderr.write(`${exposure}\n`);
  const history = await loadHistory(context, { noRefresh });
  const knowledge = await loadKnowledge(context, history, settings, { noRefresh });
  const mapped = await readMappedShare(context, settings);
  return { context, settings, history, knowledge, noRefresh, notices: mapped.notices, mappedShareUnder: mapped.under };
}

/** The `inputs` every subcommand reports: what its results depend on beyond the repository and history. Counts only, never identities. */
export function commonInputs(p: Prepared, subcommand: string, more: Record<string, unknown> = {}): Record<string, unknown> {
  const { settings, knowledge } = p;
  return {
    subcommand,
    ...more,
    activityWindowMonths: settings.activityWindowMonths,
    periodMonths: settings.periodMonths,
    abandonmentGuideline: settings.abandonmentGuideline,
    copyDetection: settings.copyDetection,
    overrides: { active: knowledge.overrides.active.size, inactive: knowledge.overrides.inactive.size, hash: knowledge.overrides.stamp },
    ...identityStamps(p.history),
  };
}

/** The sections every subcommand adds: the history's window, filters and evidence, and how complete the authorship is. */
export function commonExtra(p: Prepared, more: Record<string, unknown> = {}): NonNullable<CommandOutput["extra"]> {
  const { model } = p.knowledge;
  return {
    ...historySections(p.history),
    developers: {
      active: model.developers.filter((d) => d.active).length,
      inactive: model.developers.filter((d) => !d.active).length,
    },
    blame: { unknownFiles: model.missing.length, unattributedLines: model.files.reduce((sum, f) => sum + f.unattributed, 0) },
    ...noticesSection(p.notices),
    ...more,
  };
}
