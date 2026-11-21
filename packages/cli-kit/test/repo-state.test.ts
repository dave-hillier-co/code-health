import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { CliError, ExitCode } from "../src/errors.ts";
import { readRepoState } from "../src/repo-state.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function fixture(): GitFixture {
  const repo = GitFixture.build([
    {
      type: "commit",
      message: "first",
      date: "2024-01-01T10:00:00+00:00",
      committerDate: "2024-03-05T12:00:00+00:00",
      changes: [{ op: "add", path: "src/a.ts", content: "a\n" }],
    },
  ]);
  cleanups.push(() => repo.dispose());
  return repo;
}

test("reports HEAD sha, clean tree and the HEAD committer date", () => {
  const repo = fixture();
  const state = readRepoState(repo.path);
  expect(state.head).toBe(repo.git("rev-parse", "HEAD"));
  expect(state.dirty).toBe(false);
  expect(state.headCommitDate).toBe("2024-03-05T12:00:00.000Z");
});

test("root is the repository top level even when started in a subfolder", () => {
  const repo = fixture();
  expect(readRepoState(join(repo.path, "src")).root).toBe(readRepoState(repo.path).root);
});

test("modified tracked files make the tree dirty", () => {
  const repo = fixture();
  writeFileSync(join(repo.path, "src/a.ts"), "changed\n");
  expect(readRepoState(repo.path).dirty).toBe(true);
});

test("untracked files do not make the tree dirty", () => {
  const repo = fixture();
  writeFileSync(join(repo.path, "scratch.txt"), "x\n");
  expect(readRepoState(repo.path).dirty).toBe(false);
});

test("outside a git repository is an environment error", () => {
  const dir = mkdtempSync(join(tmpdir(), "code-health-nogit-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  expectEnvironmentError(() => readRepoState(dir), "not-a-git-repo");
});

test("a repository with no commits is an environment error", () => {
  const repo = GitFixture.create();
  cleanups.push(() => repo.dispose());
  expectEnvironmentError(() => readRepoState(repo.path), "no-commits");
});

function expectEnvironmentError(action: () => unknown, code: string): void {
  try {
    action();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(ExitCode.Environment);
    expect((error as CliError).code).toBe(code);
  }
}
