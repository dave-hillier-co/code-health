import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { adapterSamples, polyglotChanges } from "@code-health/fixtures/language-samples";
import { expectGolden } from "./support/golden.ts";
import { runComplexity } from "./support/run.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = GitFixture.build([{ type: "commit", message: "Add one file of every language", date: "2024-01-01T00:00:00+00:00", changes: polyglotChanges() }]);
});
afterAll(() => repo.dispose());

test("analyse measures a function of every supported language, and matches its golden, which the schema check validates", async () => {
  const run = await runComplexity(repo.path, ["analyse", "--json", "--limit", "all"]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  expectGolden("polyglot", "analyse", run.stdout);
  const units = (JSON.parse(run.stdout).results as { path: string; unit: string; source: string }[]).map((row) => `${row.path}#${row.unit}`);
  for (const sample of Object.values(adapterSamples)) expect(units, sample.path).toContain(`${sample.path}#${sample.unit}`);
});
