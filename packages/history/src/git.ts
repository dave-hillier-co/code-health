import { spawn } from "node:child_process";

export interface GitOptions {
  input?: string;
  /** Extra environment variables. */
  env?: Record<string, string>;
}

export class GitError extends Error {
  readonly args: string[];
  readonly code: number | null;
  readonly stderr: string;

  constructor(args: string[], code: number | null, stderr: string) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
    this.name = "GitError";
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Runs git in `cwd` and resolves with stdout. Read-only use only: the
 * analysis never modifies the analysed repository.
 */
export function runGit(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new GitError(args, code, Buffer.concat(err).toString("utf8")));
    });
    child.stdin.end(options.input ?? "");
  });
}

export async function gitVersion(cwd: string): Promise<string> {
  const out = await runGit(cwd, ["--version"]);
  return out.trim().replace(/^git version /, "");
}
