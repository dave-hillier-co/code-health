import { createHash } from "node:crypto";
import { runGit } from "./git.ts";
import { readBlameIgnoreRevs } from "./tree.ts";

export interface BlameSettings {
  /**
   * Follow lines moved or copied from other files with `-C`, so a commit that
   * only moves code does not take its authorship. On by default; turn it off
   * where it is too slow.
   */
  copyDetection?: boolean;
  /** File at the tree root listing revisions to ignore. Default `.git-blame-ignore-revs`. */
  ignoreRevsFile?: string;
}

export const DEFAULT_IGNORE_REVS_FILE = ".git-blame-ignore-revs";

export interface ResolvedBlameOptions {
  /**
   * Names the options a stored blame was made with: a short hash of the flags and of the
   * full SHAs the ignore-revs file lists at the analysed ref. Changing either gives a new id,
   * so blames made under other options are never reused.
   */
  id: string;
  copyDetection: boolean;
  /** Full SHAs of the ignored commits that exist, sorted. */
  ignoreRevs: string[];
}

/**
 * Settles the options of a blame at `sha`. The ignore-revs file is read from
 * the tree at `sha` rather than the working tree, so the same commit always
 * gives the same blame. Entries that are abbreviated are resolved, and entries
 * that name no commit are dropped.
 */
export async function resolveBlameOptions(root: string, sha: string, settings: BlameSettings = {}): Promise<ResolvedBlameOptions> {
  const copyDetection = settings.copyDetection ?? true;
  const listed = await readBlameIgnoreRevs(root, sha, settings.ignoreRevsFile ?? DEFAULT_IGNORE_REVS_FILE);
  const ignoreRevs = new Set<string>();
  if (listed.length > 0) {
    const out = await runGit(root, ["cat-file", "--batch-check"], { input: listed.join("\n") + "\n" });
    for (const line of out.split("\n")) {
      const [oid, type] = line.split(" ");
      if (type === "commit" && oid !== undefined) ignoreRevs.add(oid);
    }
  }
  const sorted = [...ignoreRevs].sort();
  // `w`, `M` and `C` are the flags the blame is made with; `v` is this layout's own version.
  const canonical = JSON.stringify({ v: 1, w: true, M: true, C: copyDetection, ignore: sorted });
  return { id: createHash("sha256").update(canonical).digest("hex").slice(0, 12), copyDetection, ignoreRevs: sorted };
}
