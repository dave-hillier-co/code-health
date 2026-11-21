import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { commitsInSnapshot, resolveOwners } from "@code-health/history/blame-owners";
import { readBlame } from "@code-health/history/blame-read";
import { refreshBlame, type BlameRefreshResult } from "@code-health/history/blame-refresh";
import type { LoadedHistory } from "../history-access.ts";
import { SECONDS_PER_MONTH, readActivity, type Activity } from "./activity.ts";
import { buildKnowledgeModel, type KnowledgeModel } from "./knowledge-model.ts";
import { readOverrides, type KnowledgeOverrides, type KnowledgeSettings } from "./settings.ts";

export interface BlameTarget {
  /** The commit whose tree is blamed. */
  sha: string;
  /** The date people are judged active at, unix seconds. */
  asOf: number;
}

export interface LoadedKnowledge {
  model: KnowledgeModel;
  activity: Activity;
  overrides: KnowledgeOverrides;
  /** The blame refresh that ran first, or null when `noRefresh` was given. */
  refreshed: BlameRefreshResult | null;
  windowSeconds: number;
  periodSeconds: number;
}

export const windowSecondsOf = (settings: KnowledgeSettings): number => settings.activityWindowMonths * SECONDS_PER_MONTH;
export const periodSecondsOf = (settings: KnowledgeSettings): number => settings.periodMonths * SECONDS_PER_MONTH;

/** The options a blame is made and read with, so the refresh and the read agree. */
export function blameOptions(history: LoadedHistory, settings: KnowledgeSettings) {
  return { exclude: history.settings.exclude, copyDetection: settings.copyDetection };
}

/** Brings the blame cache up to date with `sha`. */
export function refreshBlameFor(
  context: CommandContext,
  history: LoadedHistory,
  settings: KnowledgeSettings,
  sha: string,
  hooks: { onProgress?: (progress: { done: number; total: number }) => void; signal?: AbortSignal } = {},
): Promise<BlameRefreshResult> {
  return refreshBlame(context.repo.root, { ref: sha, ...blameOptions(history, settings), ...hooks });
}

/**
 * Builds the knowledge model at a commit: the cached blame of its tree (refreshed first
 * unless `noRefresh`), the owners of the blamed commits, and who is active at the date.
 * Overrides apply only to the present: they correct who is active now, not who was.
 */
export async function loadKnowledge(
  context: CommandContext,
  history: LoadedHistory,
  settings: KnowledgeSettings,
  options: { noRefresh: boolean; target?: BlameTarget; activity?: Activity },
): Promise<LoadedKnowledge> {
  const { root } = context.repo;
  const target = options.target ?? { sha: history.view.headSha, asOf: history.view.headDate };
  const present = options.target === undefined;
  const refreshed = options.noRefresh ? null : await refreshBlameFor(context, history, settings, target.sha);
  const snapshot = await readBlame(root, { ref: target.sha, ...blameOptions(history, settings) });
  const identity = { localMailmap: history.identities.localMailmap, matcher: history.identities.matcher };
  const owners = await resolveOwners(root, commitsInSnapshot(snapshot), identity);
  const activity = options.activity ?? (await readActivity(root, history.view.commits, identity));
  const overrides = present ? readOverrides(root) : { active: new Set<string>(), inactive: new Set<string>(), stamp: null };
  const windowSeconds = windowSecondsOf(settings);
  const model = buildKnowledgeModel({ snapshot, owners, activity, asOf: target.asOf, windowSeconds, overrides });
  return { model, activity, overrides, refreshed, windowSeconds, periodSeconds: periodSecondsOf(settings) };
}
