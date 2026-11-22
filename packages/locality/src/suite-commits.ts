import { runGit } from "@code-health/history/git";
import type { HistoryView } from "@code-health/history/read";

export interface Trailer {
  plugin: string;
  rule: string;
}

/**
 * The `Code-Health:` trailers of a commit message: `Code-Health: locality two-consumers`, or the
 * `locality/two-consumers` form. Only the last paragraph holds trailers, and the subject never does.
 */
export function codeHealthTrailers(message: string): Trailer[] {
  const paragraphs = message.replace(/\r\n/g, "\n").trim().split(/\n[ \t]*\n/);
  if (paragraphs.length < 2) return [];
  const trailers: Trailer[] = [];
  for (const line of paragraphs[paragraphs.length - 1]!.split("\n")) {
    const match = /^code-health[ \t]*:[ \t]*([^\s/]+)(?:[ \t/]+(.*?))?[ \t]*$/i.exec(line);
    if (match) trailers.push({ plugin: match[1]!.toLowerCase(), rule: match[2] ?? "" });
  }
  return trailers;
}

/** A path the suite's own commits moved away from or removed. */
export interface Action {
  sha: string;
  rule: string;
  /** The path before the commit. */
  from: string;
  /** Where it went, or null when the commit removed it (an inline). */
  to: string | null;
  /** Committer date, unix seconds. */
  date: number;
}

/**
 * What the commits after `baseline` (reachable from the view's head, not from `baseline`) did to paths, when they
 * carry a `Code-Health:` trailer naming `plugin`: renames, and removals. Edits are not actions on a unit.
 * Renames and removals by commits without the trailer are returned as `untrailered`: the outcome does not
 * attribute them to the tool, but a reader should know they happened.
 */
export async function actionsSince(
  root: string,
  view: HistoryView,
  baseline: string,
  plugin: string,
): Promise<{ actions: Action[]; untrailered: Action[]; commits: number; latest: number | null }> {
  const listing = await runGit(root, ["rev-list", `${baseline}..${view.headSha}`]);
  const later = new Set(listing.split("\n").filter((sha) => sha !== ""));
  const actions: Action[] = [];
  const untrailered: Action[] = [];
  let commits = 0;
  let latest: number | null = null;
  for (const commit of view.commits) {
    if (!later.has(commit.sha)) continue;
    const trailers = codeHealthTrailers(commit.message).filter((trailer) => trailer.plugin === plugin);
    if (trailers.length === 0) {
      for (const change of commit.changes) {
        if (change.status === "R" && change.oldPath !== null) untrailered.push({ sha: commit.sha, rule: "", from: change.oldPath, to: change.path, date: commit.committerDate });
        else if (change.status === "D") untrailered.push({ sha: commit.sha, rule: "", from: change.path, to: null, date: commit.committerDate });
      }
      continue;
    }
    commits++;
    latest = latest === null ? commit.committerDate : Math.max(latest, commit.committerDate);
    const rule = trailers[0]!.rule;
    for (const change of commit.changes) {
      if (change.status === "R" && change.oldPath !== null) actions.push({ sha: commit.sha, rule, from: change.oldPath, to: change.path, date: commit.committerDate });
      else if (change.status === "D") actions.push({ sha: commit.sha, rule, from: change.path, to: null, date: commit.committerDate });
    }
  }
  return { actions, untrailered, commits, latest };
}

/** The number of commits reachable from the view's head that carry a trailer naming `plugin`. */
export function countSuiteCommits(view: HistoryView, plugin: string): number {
  return view.commits.filter((commit) => codeHealthTrailers(commit.message).some((trailer) => trailer.plugin === plugin)).length;
}
