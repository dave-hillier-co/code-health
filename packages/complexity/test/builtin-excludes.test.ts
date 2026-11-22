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

test.each([["files"], ["analyse"], ["fixes"]])("%s leaves out .claude, a linked worktree and a nested clone", async (command) => {
  const { code, stdout, stderr } = await run(fixture.repo.path, command);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const text = paths(stdout);
  expect(text).toContain("src/alpha.ts");
  expect(text).not.toContain(".claude");
  expect(text).not.toContain("vendor/clone");
  expect(text).not.toContain("only-in-worktree");
});

test("files reports how many files each built-in entry omitted from the working tree", async () => {
  const { stdout } = await run(fixture.repo.path, "files");
  // the worktree and the clone each hold every tracked file of the main checkout
  expect(omissions(stdout)).toEqual({
    ".claude/**": fixture.claudeFiles + fixture.trackedFiles + 1,
    "<directory below the repo root that contains .git>": fixture.trackedFiles,
  });
});

test("a table says how many files the built-in excludes omitted", async () => {
  const { stdout } = await runInProcess(cli, fixture.repo.path, ["files"], true);
  expect(stdout).toContain("Notice: built-in excludes omitted");
  expect(stdout).toContain("(.claude/**)");
});

test("a run inside the linked worktree analyses the worktree", async () => {
  const { stdout } = await run(fixture.worktree, "files");
  const text = paths(stdout);
  expect(text).toContain("src/only-in-worktree.ts");
  expect(text).not.toContain(".claude");
  expect(omissions(stdout)).toEqual({ ".claude/**": fixture.claudeFiles });
});

test("the main folder does not see the file that only the worktree has", async () => {
  const { stdout } = await run(fixture.repo.path, "files");
  expect(paths(stdout)).not.toContain("only-in-worktree");
});

test("config explain prints the built-in entries with the source built-in", async () => {
  const { stdout } = await run(fixture.repo.path, "config", "explain");
  const rows = (JSON.parse(stdout).results as { path: string; value: unknown; source: string }[]).filter((row) => row.source === "built-in");
  expect(rows.map((row) => row.value)).toEqual([".claude/**", ".cache/**", ".code-health/**", "<directory below the repo root that contains .git>"]);
});
