import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoRelative } from "./repo-paths.ts";

/** The tools whose edits a post-edit hook watches. */
export const WATCHED_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/** What Claude Code sends a hook on stdin. Only the fields a hook uses are read. */
interface HookInput {
  session_id?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: { file_path?: unknown };
}

/** An edit inside a repository, as a hook sees it. */
export interface EditEvent {
  sessionId: string;
  /** The directory holding `.git`. */
  root: string;
  /** The edited file, repo-relative POSIX. */
  file: string;
}

/** The directory holding `.git`, found by walking up from `start` with no process spawned. Undefined outside a repository. */
export function findRepoRoot(start: string): string | undefined {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, ".git"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * The edit a hook's stdin describes, or undefined when it is not a watched edit of a file inside a
 * repository: no session id, no file, another tool, or a path outside the repository.
 * `fallbackCwd` is used when the input names no working directory. It throws on stdin that is not JSON.
 */
export function readEditEvent(stdin: string, fallbackCwd: string): EditEvent | undefined {
  const input = JSON.parse(stdin) as HookInput;
  const path = input.tool_input?.file_path;
  if (typeof input.session_id !== "string" || input.session_id === "" || typeof path !== "string") return undefined;
  if (typeof input.tool_name === "string" && !WATCHED_TOOLS.has(input.tool_name)) return undefined;
  const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : fallbackCwd;
  const root = findRepoRoot(cwd);
  if (root === undefined) return undefined;
  const file = repoRelative(root, path);
  if (file.startsWith("..") || file.startsWith("/") || file === "") return undefined;
  return { sessionId: input.session_id, root, file };
}

/**
 * Resolves with the work's answer, or with `silence` when the budget is spent first. The budget is
 * counted from `started`, a `performance.now()` reading. The work is abandoned, not awaited.
 */
export function within<T>(budgetMs: number, started: number, work: Promise<T>, silence: T): Promise<T> {
  const remaining = Math.max(0, budgetMs - (performance.now() - started));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(silence), remaining);
    work.then(
      (answer) => {
        clearTimeout(timer);
        resolve(answer);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
