import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { buildExcludesRepo, omissions, paths, type ExcludesRepo } from "@code-health/fixtures/excludes-repo";
import { runCochange } from "./support/run.ts";

vi.setConfig({ testTimeout: 180_000 });

let fixture: ExcludesRepo;
beforeAll(() => {
  fixture = buildExcludesRepo();
});
afterAll(() => fixture.repo.dispose());

test.each([["hotspots"], ["coupling"], ["fixes"]])("%s from history leaves out committed .claude files, a linked worktree and a nested clone", async (command) => {
  const { code, stdout, stderr } = await runCochange(fixture.repo.path, [command, "--limit", "all"]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const text = paths(stdout);
  expect(text).toContain("src/alpha.ts");
  expect(text).not.toContain(".claude");
  expect(text).not.toContain("vendor/clone");
  expect(text).not.toContain("only-in-worktree");
  expect(omissions(stdout)[".claude/**"]).toBe(fixture.claudeFiles);
});

test("a run inside the linked worktree analyses the worktree", async () => {
  const { stdout } = await runCochange(fixture.worktree, ["hotspots", "--limit", "all"]);
  expect(paths(stdout)).toContain("src/only-in-worktree.ts");
  expect(paths(stdout)).not.toContain(".claude");
  expect(JSON.parse(stdout).repo.head).toBe(fixture.repo.git("-C", fixture.worktree, "rev-parse", "HEAD").trim());
});
