import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { runCochange } from "./support/run.ts";
import { steadyHistory } from "./support/scenarios.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = steadyHistory();
});
afterAll(() => repo.dispose());

test("refresh on a new repository stores every commit and reports how many were added", async () => {
  const { code, stdout, stderr } = await runCochange(repo.path, ["refresh"]);
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  expect(JSON.parse(stdout).results).toMatchObject({ added: 6, reachable: 6, rebuilt: false });
  expectGolden("steady", "refresh", stdout);
});

test("refresh again adds nothing", async () => {
  const { stdout } = await runCochange(repo.path, ["refresh"]);
  expect(JSON.parse(stdout).results).toMatchObject({ added: 0, reachable: 6 });
  expectGolden("steady", "refresh.up-to-date", stdout);
});

test("refresh adds only the commits made since", async () => {
  repo.commit({
    message: "Tidy",
    date: "2024-06-02T09:00:00Z",
    changes: [{ op: "modify", path: "README.md", content: "# Demo\n\nTidy.\n" }],
  });
  const { stdout } = await runCochange(repo.path, ["refresh"]);
  expect(JSON.parse(stdout).results).toMatchObject({ added: 1, reachable: 7 });
});

test("refresh writes the shared cache, which ignores itself, and no report", async () => {
  expect(existsSync(join(repo.path, ".cache/code-health/history.sqlite"))).toBe(true);
  expect(readFileSync(join(repo.path, ".cache/code-health/.gitignore"), "utf8")).toBe("*\n");
  expect(existsSync(join(repo.path, ".cache/code-health/reports"))).toBe(false);
  expect(repo.git("status", "--porcelain")).toBe("");
});

test("a configured branch that does not exist is a usage error", async () => {
  writeFileSync(join(repo.path, "code-health.json"), '{"cochange":{"branch":"no-such-branch"}}\n');
  try {
    const { code, stderr } = await runCochange(repo.path, ["refresh", "--json"]);
    expect(code).toBe(ExitCode.Usage);
    expect(JSON.parse(stderr).error.code).toBe("usage");
  } finally {
    writeFileSync(join(repo.path, "code-health.json"), "{}\n");
  }
});

test("outside a git repository it is an environment error", async () => {
  const { code, stderr } = await runCochange("/", ["refresh", "--json"]);
  expect(code).toBe(ExitCode.Environment);
  expect(JSON.parse(stderr).error.code).toBe("not-a-git-repo");
});

test("refresh with a stray word is a usage error and reads no history", async () => {
  const { code, stderr, stdout } = await runCochange(repo.path, ["refresh", "backtest"]);
  expect(code).toBe(ExitCode.Usage);
  expect(stderr).toContain('refresh takes no arguments, got "backtest"');
  expect(stdout).toBe("");
});
