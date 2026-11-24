import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { analyseHistory, monthsBefore, type HistoryAnalysis } from "@code-health/history/evidence";
import { requireWindowWhenShallow } from "@code-health/history/cli-errors";
import { runGit } from "@code-health/history/git";
import { refresh, readShallowInfo, type RefreshResult } from "@code-health/history/refresh";
import { createNonPersonMatcher } from "@code-health/history/identity-classify";
import { identityFiles, readDecisions } from "@code-health/history/identity-decisions";
import { existsSync } from "node:fs";
import { readSettings, type StructureSettings } from "./config.ts";

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
  /**
   * Read all usable history instead of the analysis window, for answers about
   * a file's whole life such as its first and last revision. The returned
   * window then starts at the earliest revision.
   */
  wholeHistory?: boolean;
}

export interface LoadedHistory extends HistoryAnalysis {
  settings: StructureSettings;
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
 *
 * A shallow clone's history is truncated, so it needs a stated window, either
 * on the command line or as `structure.windowMonths` in the config file.
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
  const since = options.wholeHistory ? undefined : (options.window?.since ?? monthsBefore(anchor, settings.windowMonths));
  // The window is anchored at the analysed commit: a commit with a later committer date
  // (clock skew, a rebase) is outside it. `until` is exclusive, so the anchor itself stays in.
  const until = options.window?.until ?? anchor + 1;

  // The same author classification and local mailmap cochange reads history with, so a file's
  // revision count and the excluded counts are the same in both reports for one window.
  const files = identityFiles(root);
  const nonPerson = createNonPersonMatcher({
    botPatterns: settings.botPatterns,
    servicePatterns: [],
    agentPatterns: [],
    decisions: readDecisions(root).classifications,
  });
  const analysis = await analyseHistory(root, {
    ref: settings.ref,
    firstParent: settings.firstParent,
    mailmapFile: existsSync(files.localMailmap) ? files.localMailmap : undefined,
    noise: {
      exclude: settings.exclude,
      botPatterns: settings.botPatterns,
      nonPerson,
      maxChangesetSize: settings.maxChangesetSize,
      since,
      until,
    },
    evidence: { windowMonths: settings.windowMonths, guidelines: settings.evidenceGuidelines },
  });
  const earliest = analysis.view.commits.reduce((least, c) => Math.min(least, c.committerDate), anchor);
  return { ...analysis, settings, window: { since: since ?? earliest, until: options.window?.until ?? anchor }, refreshed };
}
