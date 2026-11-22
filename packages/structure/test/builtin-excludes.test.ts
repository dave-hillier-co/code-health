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

const run = (cwd: string, ...argv: string[]) => runInProcess(cli, cwd, [...argv, "--limit", "all"]);

test.each([["census"], ["cycles"], ["coupling"], ["hubs"]])("%s leaves out .claude, a linked worktree and a nested clone", async (command) => {
  const { code, stdout, stderr } = await run(fixture.repo.path, command);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const text = paths(stdout);
  expect(text).not.toContain(".claude");
  expect(text).not.toContain("vendor/clone");
  expect(text).not.toContain("only-in-worktree");
  expect(omissions(stdout)[".claude/**"]).toBe(fixture.claudeFiles);
});

test("a run inside the linked worktree analyses the worktree", async () => {
  const { code, stdout } = await run(fixture.worktree, "census");
  expect(code).toBe(0);
  expect(JSON.parse(stdout).repo.head).toBe(fixture.repo.git("-C", fixture.worktree, "rev-parse", "HEAD").trim());
  expect(paths(stdout)).not.toContain(".claude");
});
