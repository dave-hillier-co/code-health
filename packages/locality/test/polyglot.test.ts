import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { polyglotChanges } from "@code-health/fixtures/language-samples";
import { expectGolden } from "./support/golden.ts";
import { runLocality } from "./support/run.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = GitFixture.build([{ type: "commit", message: "Add one file of every language", date: "2024-01-01T00:00:00+00:00", changes: polyglotChanges() }]);
});
afterAll(() => repo.dispose());

test("analyse reads a repository with every supported language and matches its golden", async () => {
  const run = await runLocality(repo.path, ["analyse", "--json", "--limit", "all"]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  expectGolden("polyglot", "analyse", run.stdout);
});
