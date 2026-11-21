import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface Identity {
  name: string;
  email: string;
}

export type Change =
  | { op: "add"; path: string; content: string }
  | { op: "modify"; path: string; content: string }
  | { op: "delete"; path: string }
  /** Moves a file. Content is kept unless `content` is given. */
  | { op: "rename"; from: string; path: string; content?: string };

export interface CommitOptions {
  message: string;
  /** ISO 8601 with offset, used for both author and committer dates unless overridden. */
  date: string;
  author?: Identity;
  committer?: Identity;
  committerDate?: string;
  changes: Change[];
}

export type Step =
  | ({ type: "commit" } & CommitOptions)
  | { type: "branch"; name: string; from?: string }
  | { type: "checkout"; name: string }
  | {
      type: "merge";
      branch: string;
      message: string;
      date: string;
      author?: Identity;
      committer?: Identity;
    };

const defaultIdentity: Identity = { name: "Fixture Author", email: "author@example.com" };

/**
 * A real git repository in a temp directory, built by a script of steps with
 * fixed identities and dates so its history is reproducible.
 */
export class GitFixture {
  readonly path: string;
  private readonly root: string;

  private constructor(root: string, path: string) {
    this.root = root;
    this.path = path;
  }

  static create(defaultBranch = "main"): GitFixture {
    const root = mkdtempSync(join(tmpdir(), "code-health-fixture-"));
    const path = join(root, "repo");
    mkdirSync(path);
    const fixture = new GitFixture(root, path);
    fixture.git("init", "--quiet", `--initial-branch=${defaultBranch}`);
    fixture.git("config", "commit.gpgsign", "false");
    fixture.git("config", "core.autocrlf", "false");
    return fixture;
  }

  static build(steps: Step[]): GitFixture {
    const fixture = GitFixture.create();
    fixture.apply(steps);
    return fixture;
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  /** Runs git in the repo and returns trimmed stdout. */
  git(...args: string[]): string {
    return this.run(args, {});
  }

  apply(steps: Step[]): void {
    for (const step of steps) {
      switch (step.type) {
        case "commit":
          this.commit(step);
          break;
        case "branch":
          this.git("checkout", "--quiet", "-b", step.name, ...(step.from ? [step.from] : []));
          break;
        case "checkout":
          this.git("checkout", "--quiet", step.name);
          break;
        case "merge":
          this.merge(step);
          break;
      }
    }
  }

  commit(options: CommitOptions): void {
    for (const change of options.changes) this.applyChange(change);
    this.git("add", "--all");
    this.run(["commit", "--quiet", "--allow-empty", "-m", options.message], this.dateEnv(options));
  }

  merge(options: { branch: string; message: string; date: string; author?: Identity; committer?: Identity }): void {
    this.run(["merge", "--quiet", "--no-ff", "-m", options.message, options.branch], this.dateEnv(options));
  }

  private applyChange(change: Change): void {
    switch (change.op) {
      case "add":
      case "modify":
        this.write(change.path, change.content);
        break;
      case "delete":
        rmSync(join(this.path, change.path));
        break;
      case "rename":
        mkdirSync(dirname(join(this.path, change.path)), { recursive: true });
        this.git("mv", change.from, change.path);
        if (change.content !== undefined) this.write(change.path, change.content);
        break;
    }
  }

  private write(path: string, content: string): void {
    const full = join(this.path, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  private dateEnv(options: {
    date: string;
    author?: Identity;
    committer?: Identity;
    committerDate?: string;
  }): Record<string, string> {
    const author = options.author ?? defaultIdentity;
    const committer = options.committer ?? author;
    return {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: options.date,
      GIT_COMMITTER_NAME: committer.name,
      GIT_COMMITTER_EMAIL: committer.email,
      GIT_COMMITTER_DATE: options.committerDate ?? options.date,
    };
  }

  private run(args: string[], env: Record<string, string>): string {
    return execFileSync("git", args, {
      cwd: this.path,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        ...env,
      },
    }).trim();
  }
}
