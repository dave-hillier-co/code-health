import { treeDistance } from "@code-health/graph/tree-distance";
import type { GitFixture } from "@code-health/fixtures/git-fixture";

export interface OracleChange {
  sha: string;
  /** Unix seconds. */
  time: number;
  trailer: boolean;
  /** Each file's path as of this change, and the file's identity: the last path it had. */
  files: { path: string; id: string; deleted: boolean }[];
}

interface Touch {
  path: string;
  file: number;
  deleted: boolean;
  /** A rename with no edit: not a revision of the file. */
  pure: boolean;
}

const LOCKFILE = "package-lock.json";

/**
 * The logical changes of a fixture repository, derived from nothing but a plain
 * `git log --name-status -M` walk. It follows files through renames itself,
 * drops pure renames, lockfiles, the commits named by `.git-blame-ignore-revs`
 * and commits left empty, and leaves the maximum changeset size to the caller.
 */
export function oracleChanges(repo: GitFixture): OracleChange[] {
  const log = repo.git("log", "--reverse", "--no-merges", "-M", "--name-status", "--format=%x1e%H%x1f%ct%x1f%B%x1f");
  const ignored = repo
    .git("show", "HEAD:.git-blame-ignore-revs")
    .split("\n")
    .filter((line) => line !== "");

  // Follow each file through renames: `current` maps a path to the file living there now.
  const lastPath = new Map<number, string>();
  const current = new Map<string, number>();
  let created = 0;
  const raw: { sha: string; time: number; trailer: boolean; touches: Touch[] }[] = [];

  for (const chunk of log.split("\x1e").filter((c) => c !== "")) {
    const [sha, time, message, statuses] = chunk.split("\x1f") as [string, string, string, string];
    const touches: Touch[] = [];
    for (const line of statuses.split("\n").filter((l) => l.trim() !== "")) {
      const [status, first, second] = line.trim().split("\t") as [string, string, string | undefined];
      if (status[0] === "R") {
        const file = current.get(first)!;
        current.delete(first);
        current.set(second!, file);
        lastPath.set(file, second!);
        touches.push({ path: second!, file, deleted: false, pure: status === "R100" });
      } else if (status === "A") {
        const file = created++;
        current.set(first, file);
        lastPath.set(file, first);
        touches.push({ path: first, file, deleted: false, pure: false });
      } else if (status === "D") {
        const file = current.get(first)!;
        current.delete(first);
        touches.push({ path: first, file, deleted: true, pure: false });
      } else {
        touches.push({ path: first, file: current.get(first)!, deleted: false, pure: false });
      }
    }
    const paragraphs = message.trim().split(/\n\s*\n/);
    const trailer = paragraphs.length > 1 && /^code-health\s*:/im.test(paragraphs[paragraphs.length - 1]!);
    raw.push({ sha, time: Number(time), trailer, touches: touches.filter((t) => !t.pure) });
  }

  const changes: OracleChange[] = [];
  for (const commit of raw) {
    if (ignored.some((rev) => commit.sha.startsWith(rev))) continue;
    const files = commit.touches
      .filter((t) => t.path.slice(t.path.lastIndexOf("/") + 1) !== LOCKFILE)
      .map((t) => ({ path: t.path, id: lastPath.get(t.file) ?? t.path, deleted: t.deleted }));
    if (files.length === 0) continue;
    changes.push({ sha: commit.sha, time: commit.time, trailer: commit.trailer, files });
  }
  return changes;
}

/** Whether the file with this identity was deleted by the last change that touched it. */
export function deletedAtEnd(changes: readonly OracleChange[]): Set<string> {
  const last = new Map<string, boolean>();
  for (const change of changes) for (const file of change.files) last.set(file.id, file.deleted);
  return new Set([...last].filter(([, deleted]) => deleted).map(([id]) => id));
}

/** Every pair of eligible changes' files, counted pair by pair from the definition. */
export function oraclePairs(changes: readonly OracleChange[], maxChangeset: number) {
  const eligible = changes.filter((c) => c.files.length <= maxChangeset).map((c) => new Set(c.files.map((f) => f.id)));
  const ids = [...new Set(eligible.flatMap((set) => [...set]))].sort(compare);
  const touching = (...wanted: string[]) => eligible.filter((set) => wanted.every((id) => set.has(id))).length;
  const rows: { path: string; with: string; support: number; changesPath: number; changesWith: number }[] = [];
  for (const a of ids) {
    for (const b of ids) {
      if (compare(a, b) >= 0) continue;
      const support = touching(a, b);
      if (support > 0) rows.push({ path: a, with: b, support, changesPath: touching(a), changesWith: touching(b) });
    }
  }
  return rows;
}

export const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Linear interpolation between closest ranks, written out directly. */
export function interpolated(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const position = (sorted.length - 1) * p;
  const below = Math.floor(position);
  const fraction = position - below;
  return fraction === 0 ? sorted[below]! : sorted[below]! * (1 - fraction) + sorted[below + 1]! * fraction;
}

/** The mean of treeDistance over every unordered pair of distinct paths. */
export function meanPairDistance(paths: readonly string[]): number {
  const distinct = [...new Set(paths)];
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < distinct.length; i++) {
    for (let j = i + 1; j < distinct.length; j++) {
      total += treeDistance(distinct[i]!, distinct[j]!);
      pairs++;
    }
  }
  return pairs === 0 ? 0 : total / pairs;
}
