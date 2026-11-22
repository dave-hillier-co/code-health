import { afterEach, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { buildFixRepo } from "./support/fix-history.ts";
import { expectGolden } from "./support/golden.ts";
import { runComplexity } from "./support/run.ts";

vi.setConfig({ testTimeout: 180_000 });

const repos: GitFixture[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.dispose();
});

function fixRepo(): GitFixture {
  const repo = buildFixRepo();
  repos.push(repo);
  return repo;
}

interface Row {
  id: string;
  fixCommits: number;
  unitRevisions: number;
  fixShare: number | null;
}

test("--with-fixes adds the fix columns from the same computation as `fixes`, and matches its golden", async () => {
  const repo = fixRepo();
  const run = await runComplexity(repo.path, ["analyse", "--with-fixes", "--json", "--limit", "all"]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  expectGolden("fix-history", "analyse.fixes", run.stdout);
  const document = JSON.parse(run.stdout);
  const rows = document.results as Row[];
  expect(rows.map((row) => [row.id, row.fixCommits, row.unitRevisions, row.fixShare])).toEqual(
    expect.arrayContaining([
      ["src/billing.ts#priceOrder", 2, 5, 0.4],
      ["src/billing.ts#describe", 1, 2, 0.5],
    ]),
  );
  expect(document.fixes.commits).toMatchObject({ analysed: 11, skipped: 0 });
  expect(document.fixes.fixConvention).toMatchObject({ followsConvention: true, note: null });

  const fixes = JSON.parse((await runComplexity(repo.path, ["fixes", "--json", "--limit", "all"])).stdout).results as Row[];
  for (const row of fixes) expect(rows.find((candidate) => candidate.id === row.id)).toMatchObject({ fixCommits: row.fixCommits, unitRevisions: row.unitRevisions, fixShare: row.fixShare });
});

test("without --with-fixes the rows carry no fix columns and the history is not read", async () => {
  const run = await runComplexity(fixRepo().path, ["analyse", "--json", "--limit", "all"]);
  const document = JSON.parse(run.stdout);
  expect(document.fixes).toBeUndefined();
  expect(document.results[0].fixCommits).toBeUndefined();
});

test("a function with no fix in the window has zero fixes and a share of zero", async () => {
  const repo = fixRepo();
  repo.commit({
    message: "Add a helper",
    date: "2024-02-12T12:00:00+00:00",
    changes: [{ op: "add", path: "src/helper.ts", content: "export function helper(a: number): number {\n  return a + 1;\n}\n" }],
  });
  const rows = JSON.parse((await runComplexity(repo.path, ["analyse", "--with-fixes", "--json", "--limit", "all"])).stdout).results as Row[];
  expect(rows.find((row) => row.id === "src/helper.ts#helper")).toMatchObject({ fixCommits: 0, unitRevisions: 1, fixShare: 0 });
});
