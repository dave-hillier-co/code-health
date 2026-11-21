import { existsSync } from "node:fs";
import { join } from "node:path";
import { compileGlobs } from "./glob.ts";
import { runGit } from "./git.ts";
import { DEFAULT_LOCKFILES } from "./noise.ts";
import { listTree, readPathAttributes } from "./tree.ts";

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

/** Text files at `sha` (binary files skipped by git itself). */
async function listTextFiles(root: string, sha: string): Promise<string[]> {
  let out: string;
  try {
    out = await runGit(root, ["grep", "-I", "-c", "-z", "-e", "", sha]);
  } catch {
    return []; // git grep exits 1 when nothing matches: a tree of empty or binary files
  }
  const files: string[] = [];
  // Records are `<sha>:<path>\0<count>\n`.
  const prefix = `${sha}:`;
  for (const record of out.split("\n")) {
    if (record === "") continue;
    const [pathPart] = record.split("\0");
    if (pathPart?.startsWith(prefix)) files.push(pathPart.slice(prefix.length));
  }
  return files.sort();
}

/** Parses `git blame --incremental`: header lines are `<sha> <orig> <final> <count>`. */
export function parseIncrementalBlame(output: string, into: Map<string, number>): number {
  let lines = 0;
  for (const line of output.split("\n")) {
    const match = /^([0-9a-f]{40}) \d+ \d+ (\d+)$/.exec(line);
    if (!match) continue;
    const count = Number(match[2]);
    into.set(match[1]!, (into.get(match[1]!) ?? 0) + count);
    lines += count;
  }
  return lines;
}

/**
 * Counts the lines at `sha` by the commit that last introduced them, ignoring
 * whitespace changes and the revisions in the ignore-revs file. Vendored and
 * generated files (by gitattributes), lockfiles and excluded paths are skipped.
 * Binary files and files git cannot blame are skipped.
 */
export async function blameLineCounts(root: string, sha: string, options: BlameOptions = {}): Promise<BlamedLines> {
  const excluded = compileGlobs(options.exclude ?? []);
  const lockfiles = new Set(DEFAULT_LOCKFILES);
  const tree = await listTree(root, sha);
  const attributes = await readPathAttributes(root, sha, tree, tree);
  const text = await listTextFiles(root, sha);
  const files = text.filter(
    (path) =>
      !excluded(path) &&
      !lockfiles.has(path.slice(path.lastIndexOf("/") + 1)) &&
      !attributes.generated.has(path) &&
      !attributes.vendored.has(path),
  );

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
