import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { buildExcludesRepo, omissions, paths, type ExcludesRepo } from "@code-health/fixtures/excludes-repo";
import { runInProcess } from "@code-health/fixtures/cli-testing";
import { cli } from "../src/cli.ts";

vi.setConfig({ testTimeout: 180_000 });

let fixture: ExcludesRepo;
beforeAll(() => {
  fixture = buildExcludesRepo();
});
afterAll(() => fixture.repo.dispose());

const analyse = (cwd: string, ...args: string[]) => runInProcess(cli, cwd, ["analyse", "--limit", "all", ...args]);

test.each([[[]], [["--source", "history"]]])("analyse %j leaves out .claude, a linked worktree and a nested clone", async (args) => {
  const { code, stdout, stderr } = await analyse(fixture.repo.path, ...args);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const text = paths(stdout);
  expect(text).not.toContain(".claude");
  expect(text).not.toContain("vendor/clone");
  expect(text).not.toContain("only-in-worktree");
  expect(omissions(stdout)[".claude/**"]).toBeGreaterThanOrEqual(fixture.claudeFiles);
});

test("a run inside the linked worktree analyses the worktree", async () => {
  const { code, stdout } = await analyse(fixture.worktree);
  expect(code).toBe(0);
  expect(JSON.parse(stdout).repo.head).toBe(fixture.repo.git("-C", fixture.worktree, "rev-parse", "HEAD").trim());
  expect(paths(stdout)).not.toContain(".claude");
});
