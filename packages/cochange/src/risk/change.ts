import { usageError } from "@code-health/cli-kit/errors";
import { runGit } from "@code-health/history/git";
import { compileGlobs } from "@code-health/history/glob";
import { findAgentTrailers } from "@code-health/history/identity-classify";
import { DEFAULT_LOCKFILES } from "@code-health/history/noise";
import type { ChangeStatus } from "@code-health/history/log-parser";
import type { HistoryChange, HistoryView } from "@code-health/history/read";
import { listTree, readPathAttributes } from "@code-health/history/tree";
import { resolveOwners, type Owner, type OwnerOptions } from "@code-health/history/blame-owners";

/** The change under review, before any factor is read from it. */
export interface BranchChange {
  /** The merge base: where the change starts. */
  base: string;
  /** The branch tip. */
  head: string;
  /** What the base was taken against, for the output: the configured main branch, a named ref, or null. */
  against: string | null;
  worktree: boolean;
  /** Commits of `BASE..HEAD`, oldest first. */
  commits: { sha: string; message: string }[];
  /** Files left after the noise filters, pure renames left out. Paths are as the change leaves them. */
  files: HistoryChange[];
  /** Files moved or renamed, pure renames included. */
  moved: number;
  /** Changed paths the noise filters removed. */
  filtered: number;
  /** Commits that carry an agent `Co-Authored-By` trailer. */
  agentCommits: number;
  /** Mapped owner of each commit, from the mailmap and the identity classification. */
  owners: Map<string, Owner>;
}

export interface RangeRequest {
  /** The `BASE[..HEAD]` argument, when given. */
  range: string | undefined;
  mainBranch: string | null;
  worktree: boolean;
}

const git = async (root: string, args: string[]): Promise<string> => (await runGit(root, args)).trim();

async function exists(root: string, ref: string): Promise<boolean> {
  try {
    await runGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** The branch changes are merged into: the configured one, the remote's default, then `main`, then `master`. */
export async function findMainBranch(root: string, configured: string | null): Promise<string | null> {
  if (configured !== null) {
    if (!(await exists(root, configured))) throw usageError(`cochange.risk.mainBranch "${configured}" is not a branch or ref in this repository`);
    return configured;
  }
  try {
    const remote = await git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    if (remote !== "" && (await exists(root, remote))) return remote.replace(/^refs\/remotes\//, "");
  } catch {
    // no remote default
  }
  for (const candidate of ["main", "master"]) if (await exists(root, candidate)) return candidate;
  return null;
}

/** Resolves `BASE`, `BASE..HEAD` or `BASE...HEAD` to a merge base and a tip. */
export async function resolveRange(root: string, request: RangeRequest): Promise<{ base: string; head: string; against: string | null }> {
  const parts = request.range === undefined ? null : /^(.*?)(\.\.\.?)(.*)$/.exec(request.range);
  const named = parts === null ? request.range : parts[1] || undefined;
  const tip = parts === null ? "HEAD" : parts[3] || "HEAD";
  if (!(await exists(root, tip))) throw usageError(`"${tip}" is not a commit in this repository`);
  const head = await git(root, ["rev-parse", `${tip}^{commit}`]);
  if (request.worktree && head !== (await git(root, ["rev-parse", "HEAD"]))) {
    throw usageError("--worktree adds uncommitted edits, so the change must end at the checked out HEAD");
  }
  let against = named ?? null;
  if (against === null) {
    against = await findMainBranch(root, request.mainBranch);
    if (against === null) throw usageError("there is no main branch to take the base from: name one with cochange risk BASE, or set cochange.risk.mainBranch");
  } else if (!(await exists(root, against))) {
    throw usageError(`"${against}" is not a commit in this repository`);
  }
  let base: string;
  try {
    base = await git(root, ["merge-base", against, head]);
  } catch {
    throw usageError(`"${against}" and "${tip}" have no common ancestor`);
  }
  return { base, head, against };
}

function parseStatus(raw: string): { status: ChangeStatus; similarity: number | null } {
  const letter = raw[0] ?? "M";
  const similarity = raw.length > 1 ? Number(raw.slice(1)) : null;
  if (letter === "A" || letter === "D" || letter === "R") return { status: letter, similarity: letter === "R" ? similarity : null };
  if (letter === "C") return { status: "A", similarity: null };
  return { status: "M", similarity: null };
}

interface RawFile {
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
  similarity: number | null;
  added: number | null;
  deleted: number | null;
  binary: boolean;
}

async function rawDiff(root: string, base: string, head: string | null, similarity: number): Promise<RawFile[]> {
  const target = head === null ? [base] : [base, head];
  const common = ["diff", "-z", `-M${similarity}%`, "--no-ext-diff"];
  const statuses = (await runGit(root, [...common, "--name-status", ...target])).split("\0");
  const found = new Map<string, RawFile>();
  for (let i = 0; i < statuses.length; ) {
    const code = statuses[i++];
    if (code === undefined || code === "") continue;
    const { status, similarity: similar } = parseStatus(code);
    const first = statuses[i++]!;
    const second = code[0] === "R" || code[0] === "C" ? statuses[i++]! : null;
    const path = second ?? first;
    found.set(path, { path, oldPath: status === "R" ? first : null, status, similarity: similar, added: 0, deleted: 0, binary: false });
  }
  const numbers = (await runGit(root, [...common, "--numstat", ...target])).split("\0");
  for (let i = 0; i < numbers.length; ) {
    const record = numbers[i++];
    if (record === undefined || record === "") continue;
    const [added, deleted, inline] = record.split("\t");
    // A rename lists its two paths as separate records after an empty one.
    const path = inline === "" ? (i++, numbers[i++]!) : inline!;
    const file = found.get(path);
    if (!file) continue;
    file.binary = added === "-";
    file.added = file.binary ? null : Number(added);
    file.deleted = file.binary ? null : Number(deleted);
  }
  return [...found.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface ExtractOptions {
  similarity: number;
  exclude: readonly string[];
  owner: OwnerOptions;
  agentPatterns: readonly string[];
}

/**
 * The change `BASE..HEAD` (plus uncommitted edits to tracked files with `--worktree`), treated as one
 * logical change whatever the branch's commit granularity. Files are filtered as the history is: excluded
 * globs, lockfiles, generated and vendored paths, and pure renames, which are counted as moves.
 * `identity` places a path on the stable identity the history uses, so renames line up with their past.
 */
export async function extractChange(
  root: string,
  view: HistoryView,
  range: { base: string; head: string; against: string | null },
  worktree: boolean,
  options: ExtractOptions,
): Promise<BranchChange> {
  const raw = await rawDiff(root, range.base, worktree ? null : range.head, options.similarity);
  const excluded = compileGlobs(options.exclude);
  const lockfiles = new Set(DEFAULT_LOCKFILES);
  const tree = await listTree(root, range.head);
  const attributes = await readPathAttributes(root, range.head, raw.map((file) => file.path).sort(), tree);

  let moved = 0;
  let filtered = 0;
  const files: HistoryChange[] = [];
  for (const file of raw) {
    const pureRename = file.status === "R" && file.similarity === 100 && (file.added ?? 0) === 0 && (file.deleted ?? 0) === 0;
    const dropped =
      excluded(file.path) ||
      lockfiles.has(file.path.slice(file.path.lastIndexOf("/") + 1)) ||
      attributes.generated.has(file.path) ||
      attributes.vendored.has(file.path);
    if (dropped) {
      filtered++;
      continue;
    }
    if (file.status === "R") moved++;
    if (pureRename) continue;
    files.push({
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      similarity: file.similarity,
      added: file.added,
      deleted: file.deleted,
      binary: file.binary,
      blob: null,
      // The history names a file by its last known path, so a branch that renames a file still meets its past.
      fileId: view.renames.resolve(file.oldPath ?? file.path, -1),
    });
  }

  const log = await runGit(root, ["log", "--reverse", "--format=%H%x1f%B%x1e", `${range.base}..${range.head}`]);
  const commits = log
    .split("\x1e")
    .map((entry) => entry.replace(/^\n/, ""))
    .filter((entry) => entry.trim() !== "")
    .map((entry) => {
      const [sha, ...message] = entry.split("\x1f");
      return { sha: sha!.trim(), message: message.join("\x1f") };
    });
  const owners = await resolveOwners(root, commits.map((c) => c.sha), options.owner);
  const agentCommits = commits.filter((c) => findAgentTrailers(c.message, options.agentPatterns).length > 0).length;
  return { ...range, worktree, commits, files, moved, filtered, agentCommits, owners };
}
