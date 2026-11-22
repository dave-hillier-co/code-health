import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitFixture, type Change, type Step } from "./git-fixture.ts";

const guard = (round: number): string =>
  `import { alpha } from "../../src/alpha";\n\nexport function guard(input: number): number {\n  if (input > ${round}) {\n    for (let i = 0; i < input; i++) {\n      if (i % 2 === 0) return alpha(i);\n    }\n  }\n  return 0;\n}\n`;

const alpha = (round: number): string =>
  `import { beta } from "./beta";\n\nexport function alpha(input: number): number {\n  if (input > ${round}) {\n    for (let i = 0; i < input; i++) {\n      if (i % 3 === 0) return beta(i);\n    }\n  }\n  return input;\n}\n`;

const beta = (round: number): string =>
  `export function beta(input: number): number {\n  if (input > ${round}) {\n    return input * 2;\n  }\n  return input;\n}\n`;

function round(n: number): Step {
  const changes: Change[] = [
    { op: n === 1 ? "add" : "modify", path: "src/alpha.ts", content: alpha(n) },
    { op: n === 1 ? "add" : "modify", path: "src/beta.ts", content: beta(n) },
    { op: n === 1 ? "add" : "modify", path: ".claude/settings.json", content: `{"round": ${n}}\n` },
    { op: n === 1 ? "add" : "modify", path: ".claude/hooks/guard.ts", content: guard(n) },
  ];
  return {
    type: "commit",
    message: n % 2 === 0 ? `fix: round ${n}` : `round ${n}`,
    date: `2024-0${n}-10T09:00:00Z`,
    changes,
  };
}

export interface ExcludesRepo {
  repo: GitFixture;
  /** An untracked, unignored linked worktree under `.claude/worktrees/`. It holds one file the main checkout does not. */
  worktree: string;
  /** An untracked clone of the repository below the root. */
  clone: string;
  /** Tracked files of the main checkout that sit under `.claude`. */
  claudeFiles: number;
  /** Tracked files of the main checkout. */
  trackedFiles: number;
}

/**
 * A repository whose history changes source files and committed `.claude` files together, with a linked worktree
 * under `.claude/worktrees/` and a nested clone that git does not track.
 */
export function buildExcludesRepo(): ExcludesRepo {
  const repo = GitFixture.build([1, 2, 3, 4, 5, 6, 7, 8].map(round));
  const tracked = repo.git("ls-files").split("\n").filter((path) => path !== "");
  repo.git("worktree", "add", "--quiet", ".claude/worktrees/wt", "-b", "wt-branch");
  const worktree = join(repo.path, ".claude/worktrees/wt");
  writeFileSync(join(worktree, "src/only-in-worktree.ts"), "export const marker = 1;\n");
  repo.git("-C", worktree, "add", "src/only-in-worktree.ts");
  repo.git("-C", worktree, "-c", "user.name=Fixture Author", "-c", "user.email=author@example.com", "commit", "--quiet", "-m", "add marker");
  repo.git("clone", "--quiet", ".", "vendor/clone");
  return {
    repo,
    worktree,
    clone: join(repo.path, "vendor/clone"),
    claudeFiles: tracked.filter((path) => path.startsWith(".claude/")).length,
    trackedFiles: tracked.length,
  };
}

/** The JSON output without the parts that name the built-in excludes themselves: `meta` and the omission counts. */
export function paths(stdout: string): string {
  const { meta: _meta, omittedByBuiltinExcludes: _omitted, ...document } = JSON.parse(stdout);
  return JSON.stringify(document);
}

export function omissions(stdout: string): Record<string, number> {
  return JSON.parse(stdout).omittedByBuiltinExcludes ?? {};
}
