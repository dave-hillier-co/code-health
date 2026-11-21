import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { analyseHistory, monthsBefore, type HistoryAnalysis } from "@code-health/history/evidence";
import { requireWindowWhenShallow } from "@code-health/history/cli-errors";
import { runGit } from "@code-health/history/git";
import { refresh, readShallowInfo, type RefreshResult } from "@code-health/history/refresh";
import { readSettings, type CochangeSettings } from "./config.ts";

/** Brings the shared history cache up to date for the configured ref. */
export async function refreshHistory(context: CommandContext, settings = readSettings(context.config)): Promise<RefreshResult> {
  return refresh(context.repo.root, {
    ref: settings.ref,
    similarity: settings.renameSimilarity,
    renameLimit: settings.renameLimit,
  });
}

/** A window the command's own options state, in unix seconds of committer date. `since` is inclusive. */
export interface ExplicitWindow {
  since?: number;
  until?: number;
}

export interface HistoryOptions {
  /** Read the cache as it is. Without it the cache is brought up to date first. */
  noRefresh?: boolean;
  window?: ExplicitWindow;
}

export interface LoadedHistory extends HistoryAnalysis {
  settings: CochangeSettings;
  /** What the results were limited to, in unix seconds. `until` is the analysed commit's date. */
  window: { since: number; until: number };
  /** The refresh that ran first, or null when `noRefresh` was given. */
  refreshed: RefreshResult | null;
}

/**
 * The history every analysis command starts from.
 *
 * Auto-refresh policy: the cache is refreshed before every analysis, because an
 * incremental refresh with nothing new costs one `git rev-list`, and a stale
 * answer silently describes an older repository. `noRefresh` skips it for
 * callers that must not write; a missing cache is then an environment error.
 * Hooks never come through here, since they never refresh (suite spec, Hooks).
 *
 * A shallow clone's history is truncated, so it needs a stated window, either
 * on the command line or as `cochange.windowMonths` in the config file.
 *
 * Time is anchored to the analysed commit's committer date, never the wall clock.
 */
export async function loadHistory(context: CommandContext, options: HistoryOptions = {}): Promise<LoadedHistory> {
  const settings = readSettings(context.config);
  const { root } = context.repo;

  const shallow = await readShallowInfo(root);
  requireWindowWhenShallow(shallow, options.window !== undefined || settings.windowStated);

  const refreshed = options.noRefresh ? null : await refreshHistory(context, settings);

  const anchor = Number((await runGit(root, ["log", "-1", "--format=%ct", settings.ref])).trim());
  const since = options.window?.since ?? monthsBefore(anchor, settings.windowMonths);
  const until = options.window?.until;

  const analysis = await analyseHistory(root, {
    ref: settings.ref,
    firstParent: settings.firstParent,
    noise: {
      exclude: settings.exclude,
      botPatterns: settings.botPatterns,
      maxChangesetSize: settings.maxChangesetSize,
      since,
      until,
    },
    evidence: { windowMonths: settings.windowMonths, thresholds: settings.evidenceThresholds },
  });
  return { ...analysis, settings, window: { since, until: until ?? anchor }, refreshed };
}
