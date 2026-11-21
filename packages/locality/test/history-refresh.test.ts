import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { sharedHelper } from "./support/history-scenarios.ts";
import { runLocality } from "./support/run.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = sharedHelper({ consumers: 2, together: true, helperAdded: "2023-01-05T09:00:00Z" });
});
afterAll(() => repo.dispose());

test("history refresh builds the cache without any other plugin, and again adds nothing", async () => {
  const first = await runLocality(repo.path, ["history", "refresh", "--json"]);
  expect(first.stderr).toBe("");
  expect(first.code).toBe(ExitCode.Success);
  expect(JSON.parse(first.stdout).results).toMatchObject({ added: 13, reachable: 13, rebuilt: false });
  expect(existsSync(join(repo.path, ".cache", "code-health", "history.sqlite"))).toBe(true);
  expectGolden("shared-helper", "history", first.stdout);

  const second = await runLocality(repo.path, ["history", "refresh", "--json"]);
  expect(JSON.parse(second.stdout).results).toMatchObject({ added: 0, reachable: 13 });
});

test("history needs its subcommand", async () => {
  const run = await runLocality(repo.path, ["history"]);
  expect(run.code).toBe(ExitCode.Usage);
});
