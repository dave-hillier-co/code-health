import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { knowledgeHistory } from "./support/knowledge-scenario.ts";
import { runCochange } from "./support/run.ts";

vi.setConfig({ testTimeout: 120_000 });

let repo: GitFixture;
beforeAll(() => {
  repo = knowledgeHistory();
});
afterAll(() => repo.dispose());
beforeEach(() => {
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
  writeFileSync(join(repo.path, "code-health.json"), "{}");
});

const blame = (...args: string[]) => runCochange(repo.path, ["blame", ...args]);

test("the first refresh blames every authored file, and the next reuses them all", async () => {
  const first = await blame("refresh");
  expect(first.stderr).toBe("");
  expect(first.code).toBe(ExitCode.Success);
  expect(JSON.parse(first.stdout).results).toMatchObject({ files: 8, blamed: 8, reused: 0, noText: 0, failed: [], pruned: 0, rebuilt: false, aborted: false });
  expectGolden("abandonment", "blame.refresh", first.stdout);

  const second = JSON.parse((await blame("refresh")).stdout);
  expect(second.results).toMatchObject({ files: 8, blamed: 0, reused: 8 });
});

test("it needs no opt-in, because the cache holds commits and never people", async () => {
  const { code } = await blame("refresh");
  expect(code).toBe(ExitCode.Success);
});

test("it takes only the refresh subcommand", async () => {
  expect((await blame()).code).toBe(ExitCode.Usage);
  expect((await blame("refresh", "extra")).code).toBe(ExitCode.Usage);
});
