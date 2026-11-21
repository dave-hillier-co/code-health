import { afterAll, beforeAll, expect, test } from "vitest";
import { cli as cochange } from "@code-health/cochange/src/cli.ts";
import { runInProcess } from "@code-health/fixtures/cli-testing";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { runComplexity } from "./support/run.ts";
import { buildRepo } from "./support/scenarios.ts";

/**
 * The plugins share no runtime, only a report file. After a whole-repository `complexity files` run on a
 * clean tree, cochange's hotspots names the report as an input and uses its complexity column.
 */
let repo: GitFixture;
beforeAll(() => {
  repo = buildRepo();
});
afterAll(() => repo.dispose());

const hotspots = async () => JSON.parse((await runInProcess(cochange, repo.path, ["hotspots", "--json", "--limit", "all"])).stdout);

test("cochange hotspots reads the complexity.files report once it exists, and falls back to indentation before", async () => {
  const before = await hotspots();
  expect(before.complexitySource).toBe("indentation");
  expect(before.inputs.complexityReport).toBeNull();

  const run = await runComplexity(repo.path, ["files", "--json", "--limit", "all"]);
  expect(run.code).toBe(0);
  const files = JSON.parse(run.stdout);

  const after = await hotspots();
  expect(after.complexitySource).toBe("complexity-report");
  expect(after.inputs.complexityReport).toEqual({ report: "complexity.files", head: files.repo.head, config: expect.stringMatching(/^[0-9a-f]{16}$/) });
  const complexity = Object.fromEntries(after.results.map((row: { path: string; complexity: number }) => [row.path, row.complexity]));
  for (const row of files.results as { path: string; complexity: number }[]) expect(complexity[row.path]).toBe(row.complexity);
});
