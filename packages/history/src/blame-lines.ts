import { existsSync } from "node:fs";
import { join } from "node:path";
import { compileGlobs } from "./glob.ts";
import { runGit } from "./git.ts";
import { DEFAULT_LOCKFILES } from "./noise.ts";
import { recordDropped } from "@code-health/cli-kit/dropped-files";
import { classifyFiles } from "./file-class.ts";
import { listBlobs, type TreeBlob } from "./tree.ts";

export interface BlameOptions {
  /** Globs of paths left out, usually the suite's `exclude`. */
  exclude?: readonly string[];
  /** Files at the tree root listing revisions to ignore. Default `.git-blame-ignore-revs`. */
  ignoreRevsFile?: string;
  /** Blames running at once. Default 8. */
  concurrency?: number;
}

export interface BlamedLines {
  /** Lines at the ref per commit that last introduced them. */
  bySha: Map<string, number>;
  files: number;
  lines: number;
}

/** Paths per `git grep` call, so a long list never exceeds the argument limit. */
const GREP_CHUNK = 200;

/**
 * Which of `paths` hold text at `sha`: git itself skips binary files, and a
 * file with no lines has nothing to blame, so neither is listed.
 */
export async function textFilesAt(root: string, sha: string, paths: readonly string[]): Promise<Set<string>> {
  const text = new Set<string>();
  const prefix = `${sha}:`;
  for (let i = 0; i < paths.length; i += GREP_CHUNK) {
    let out: string;
    try {
      out = await runGit(root, ["--literal-pathspecs", "grep", "-I", "-c", "-z", "-e", "", sha, "--", ...paths.slice(i, i + GREP_CHUNK)]);
    } catch {
      continue; // git grep exits 1 when nothing matches: only empty or binary files
    }
    // Records are `<sha>:<path>\0<count>\n`.
    for (const record of out.split("\n")) {
      const [pathPart] = record.split("\0");
      if (pathPart?.startsWith(prefix)) text.add(pathPart.slice(prefix.length));
    }
  }
  return text;
}

/**
 * The files of the tree at `sha` that count as authored code: not excluded, not a
 * lockfile, and not generated or vendored (attributes, generated-code header, vendor directory). Whether they hold
 * text is a separate question (`textFilesAt`).
 */
export async function authoredFilesAt(root: string, sha: string, exclude: readonly string[] = []): Promise<TreeBlob[]> {
  const excluded = compileGlobs(exclude);
  const lockfiles = new Set(DEFAULT_LOCKFILES);
  const blobs = await listBlobs(root, sha);
  const paths = blobs.map((b) => b.path);
  const classes = await classifyFiles(root, sha, blobs, paths);
  return blobs.filter(({ path }) => {
    if (excluded(path) || lockfiles.has(path.slice(path.lastIndexOf("/") + 1))) return false;
    if (classes.generated.has(path)) {
      recordDropped("generated", path);
      return false;
    }
    if (classes.vendored.has(path)) {
      recordDropped("vendored", path);
      return false;
    }
    return true;
  });
}

export interface BlameRange {
  /** First line of the range in the file as blamed, counting from 1. */
  start: number;
  count: number;
  /** The commit that last introduced these lines. */
  sha: string;
}

/**
 * Parses `git blame --incremental` into ranges, ordered by line, adjacent
 * ranges of one commit joined. Header lines are `<sha> <orig> <final> <count>`.
 */
export function parseBlameRanges(output: string): BlameRange[] {
  const ranges: BlameRange[] = [];
  for (const line of output.split("\n")) {
    const match = /^([0-9a-f]{40}) \d+ (\d+) (\d+)$/.exec(line);
    if (match) ranges.push({ start: Number(match[2]), count: Number(match[3]), sha: match[1]! });
  }
  ranges.sort((a, b) => a.start - b.start);
  const joined: BlameRange[] = [];
  for (const range of ranges) {
    const last = joined[joined.length - 1];
    if (last && last.sha === range.sha && last.start + last.count === range.start) last.count += range.count;
    else joined.push({ ...range });
  }
  return joined;
}

/** Adds the lines of one `git blame --incremental` run to `into`, per commit. Returns the line count. */
export function parseIncrementalBlame(output: string, into: Map<string, number>): number {
  let lines = 0;
  for (const range of parseBlameRanges(output)) {
    into.set(range.sha, (into.get(range.sha) ?? 0) + range.count);
    lines += range.count;
  }
  return lines;
}

/**
 * Counts the lines at `sha` by the commit that last introduced them, ignoring
 * whitespace changes and the revisions in the ignore-revs file. Vendored and
 * generated files (by gitattributes), lockfiles and excluded paths are skipped.
 * Binary files and files git cannot blame are skipped.
 *
 * Nothing is cached and moved or copied lines are not followed: this is the
 * quick measure the identity commands use. `blame-refresh.ts` keeps the full
 * authorship in the shared cache.
 */
export async function blameLineCounts(root: string, sha: string, options: BlameOptions = {}): Promise<BlamedLines> {
  const candidates = await authoredFilesAt(root, sha, options.exclude);
  const text = await textFilesAt(root, sha, candidates.map((c) => c.path));
  const files = candidates.map((c) => c.path).filter((path) => text.has(path));

  const ignoreFile = options.ignoreRevsFile ?? ".git-blame-ignore-revs";
  const ignoreArgs = existsSync(join(root, ignoreFile)) ? [`--ignore-revs-file=${join(root, ignoreFile)}`] : [];
  const bySha = new Map<string, number>();
  let lines = 0;
  let next = 0;
  let blamed = 0;
  const worker = async () => {
    while (next < files.length) {
      const path = files[next++]!;
      try {
        const out = await runGit(root, ["blame", "--incremental", "-w", ...ignoreArgs, sha, "--", path]);
        lines += parseIncrementalBlame(out, bySha);
        blamed++;
      } catch {
        // a file git cannot blame (for example a submodule path) is left out
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 8, Math.max(files.length, 1)) }, worker));
  return { bySha, files: blamed, lines };
}
