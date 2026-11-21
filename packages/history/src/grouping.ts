import type { HistoryChange } from "./read.ts";

/**
 * How commits form logical changes. Grouping is opt-in because the wrong grouping invents coupling.
 *
 * - `off`: every commit is its own change.
 * - `issue-key`: commits whose message matches `pattern` with the same key form one change. The key
 *   is the first capture group of the first match, or the whole match when the pattern has none.
 *   Commits with no key stay on their own.
 * - `author-window`: commits by the same author form one change while each follows the previous one
 *   by at most `windowSeconds`, so a burst of commits is one change and a pause ends it.
 */
export type Grouping =
  | { mode: "off" }
  | { mode: "issue-key"; pattern: string }
  | { mode: "author-window"; windowSeconds: number };

/** The issue keys of common trackers: `ABC-123`. */
export const DEFAULT_ISSUE_PATTERN = "[A-Z][A-Z0-9]+-\\d+";

export const DEFAULT_WINDOW_SECONDS = 4 * 3600;

export interface Groupable {
  message: string;
  /** The author as the analysis counts them: the mapped email. */
  author: string;
  /** Committer date, unix seconds. */
  date: number;
}

/**
 * Partitions commits, given oldest first, into groups of indexes. Indexes ascend within a group and
 * the groups are ordered by their last index, so a change appears where its final commit does.
 */
export function groupCommits(items: readonly Groupable[], grouping: Grouping, compilePattern: (pattern: string) => RegExp): number[][] {
  if (grouping.mode === "off") return items.map((_, index) => [index]);

  const groups: number[][] = [];
  if (grouping.mode === "issue-key") {
    const pattern = compilePattern(grouping.pattern);
    const open = new Map<string, number[]>();
    items.forEach((item, index) => {
      const match = pattern.exec(item.message);
      const key = match === null ? undefined : (match[1] ?? match[0]);
      if (key === undefined || key === "") return void groups.push([index]);
      let group = open.get(key);
      if (!group) {
        group = [];
        open.set(key, group);
        groups.push(group);
      }
      group.push(index);
    });
  } else {
    const open = new Map<string, number[]>();
    items.forEach((item, index) => {
      const group = open.get(item.author);
      const last = group === undefined ? undefined : items[group.at(-1)!]!.date;
      if (group !== undefined && Math.abs(item.date - last!) <= grouping.windowSeconds) {
        group.push(index);
      } else {
        const fresh = [index];
        open.set(item.author, fresh);
        groups.push(fresh);
      }
    });
  }
  return groups.sort((a, b) => a.at(-1)! - b.at(-1)!);
}

/**
 * One file's changes across the commits of a group, as a single change. Line counts add up, so churn
 * is preserved. The path, status and blob are those after the last commit, and the old path is the
 * one before the first, so the file is placed where the change leaves it.
 */
export function mergeFileChanges(changes: readonly HistoryChange[]): HistoryChange {
  const first = changes[0]!;
  const last = changes.at(-1)!;
  if (changes.length === 1) return first;
  const total = (pick: (c: HistoryChange) => number | null): number | null => {
    const counted = changes.map(pick).filter((n) => n !== null);
    return counted.length === 0 ? null : counted.reduce((a, b) => a + b, 0);
  };
  return {
    ...last,
    // A file created inside the group is an addition of the change, however often it was edited after.
    status: first.status === "A" && last.status !== "D" ? "A" : last.status,
    oldPath: first.oldPath,
    similarity: first.similarity,
    added: total((c) => c.added),
    deleted: total((c) => c.deleted),
    binary: changes.some((c) => c.binary),
  };
}
