import { execFileSync } from "node:child_process";
import { environmentError } from "./errors.ts";

export interface RepoState {
  /** Absolute path of the working tree top level. */
  root: string;
  head: string;
  /** True when tracked files differ from HEAD. Untracked files are ignored. */
  dirty: boolean;
  /** HEAD's committer date as an ISO 8601 UTC string. Time-based analysis is anchored here. */
  headCommitDate: string;
  gitVersion: string;
}

/** Reads repository facts with read-only git commands. Environment errors exit 3. */
export function readRepoState(cwd: string): RepoState {
  let root: string;
  try {
    root = git(cwd, "rev-parse", "--show-toplevel");
  } catch {
    throw environmentError("not-a-git-repo", `${cwd} is not inside a git repository`);
  }

  let head: string;
  let headCommitDate: string;
  try {
    head = git(root, "rev-parse", "--verify", "HEAD");
    headCommitDate = new Date(git(root, "log", "-1", "--format=%cI", "HEAD")).toISOString();
  } catch {
    throw environmentError("no-commits", "the repository has no commits");
  }

  const dirty = git(root, "status", "--porcelain", "--untracked-files=no") !== "";
  const gitVersion = git(root, "--version").replace(/^git version /, "");
  return { root, head, dirty, headCommitDate, gitVersion };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 1024 * 1024 * 1024,
    // Analysis never modifies the repository: do not refresh the index under a lock.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
}
