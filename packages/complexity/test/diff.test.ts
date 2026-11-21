import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { Change, GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { runComplexity } from "./support/run.ts";
import { oneMoreBranch, priceFunction, repoWithFeature, riskyFunction, simpleFunction } from "./support/ratchet.ts";

const repos: GitFixture[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.dispose();
});

function repoWith(changes: Change[]): GitFixture {
  const repo = repoWithFeature(changes);
  repos.push(repo);
  return repo;
}

interface Row {
  id: string;
  change: "added" | "changed";
  renamedFrom: string | null;
  before: Record<string, number> | null;
  after: Record<string, number>;
  delta: Record<string, number> | null;
  labels: string[];
}

async function diff(repo: GitFixture, range: string) {
  const run = await runComplexity(repo.path, ["diff", range, "--json", "--limit", "all"]);
  const document = run.stdout === "" ? undefined : JSON.parse(run.stdout);
  return { ...run, document, rows: (document?.results ?? []) as Row[] };
}

test("lists a changed function with its metrics before and after and the difference", async () => {
  const repo = repoWith([{ op: "modify", path: "src/pricing.ts", content: priceFunction("price", oneMoreBranch) }]);
  const run = await diff(repo, "main..feature");
  expect(run.code).toBe(ExitCode.Success);
  expectGolden("ratchet-worsened", "diff", run.stdout);
  expect(run.rows).toHaveLength(1);
  const [row] = run.rows;
  expect(row).toMatchObject({ id: "src/pricing.ts#price", change: "changed", renamedFrom: null });
  expect([row!.before!.cognitive, row!.after.cognitive, row!.delta!.cognitive]).toEqual([8, 9, 1]);
  expect(row!.labels).toEqual(["cyclomatic-warn", "cognitive-warn"]);
});

test("lists new functions as added, with no before, and leaves out functions that did not change", async () => {
  const repo = repoWith([
    { op: "add", path: "src/risky.ts", content: riskyFunction },
    { op: "add", path: "src/simple.ts", content: simpleFunction },
  ]);
  const run = await diff(repo, "main..feature");
  expect(run.rows.map((row) => [row.id, row.change, row.before])).toEqual([
    ["src/risky.ts#risky", "added", null],
    ["src/simple.ts#simple", "added", null],
  ]);
  expect(run.document.summary).toEqual({ added: 2, changed: 0, removed: 0, moved: 0, unchanged: 0 });
  expectGolden("ratchet-added", "diff", run.stdout);
});

test("a function that only moved is matched to itself and not listed", async () => {
  const repo = repoWith([
    { op: "modify", path: "src/pricing.ts", content: "export const unrelated = 1;\n" },
    { op: "add", path: "src/billing.ts", content: priceFunction() },
  ]);
  const run = await diff(repo, "main..feature");
  expect(run.rows.map((row) => row.id)).toEqual([]);
  expect(run.document.summary).toMatchObject({ moved: 1, unchanged: 1, added: 0 });
});

test("a function that moved and changed is listed, naming where it came from", async () => {
  const repo = repoWith([
    { op: "modify", path: "src/pricing.ts", content: "export const unrelated = 1;\n" },
    { op: "add", path: "src/billing.ts", content: priceFunction("computePrice", oneMoreBranch) },
  ]);
  const run = await diff(repo, "main..feature");
  expect(run.rows).toHaveLength(1);
  expect(run.rows[0]).toMatchObject({ id: "src/billing.ts#computePrice", change: "changed", renamedFrom: "src/pricing.ts#price" });
  expectGolden("ratchet-moved", "diff", run.stdout);
});

test("a revision alone is compared with the working tree, uncommitted and new files included", async () => {
  const repo = repoWith([{ op: "add", path: "src/simple.ts", content: simpleFunction }]);
  writeFileSync(join(repo.path, "src/risky.ts"), riskyFunction);
  const run = await diff(repo, "main");
  expect(run.document.inputs).toMatchObject({ against: "working-tree", head: null });
  expect(run.rows.map((row) => row.id)).toEqual(["src/risky.ts#risky", "src/simple.ts#simple"]);
  expectGolden("ratchet-dirty", "diff", run.stdout);
});

test("sorts the largest rise in cognitive complexity first", async () => {
  const repo = repoWith([
    { op: "add", path: "src/simple.ts", content: simpleFunction },
    { op: "add", path: "src/risky.ts", content: riskyFunction },
  ]);
  const run = await diff(repo, "main..feature");
  expect(run.rows.map((row) => row.id)[0]).toBe("src/risky.ts#risky");
});

test("rejects a missing, malformed or unknown revision", async () => {
  const repo = repoWith([{ op: "add", path: "src/simple.ts", content: simpleFunction }]);
  expect((await runComplexity(repo.path, ["diff"])).code).toBe(ExitCode.Usage);
  expect((await runComplexity(repo.path, ["diff", "a..b..c"])).code).toBe(ExitCode.Usage);
  expect((await runComplexity(repo.path, ["diff", "main.."])).code).toBe(ExitCode.Usage);
  expect((await runComplexity(repo.path, ["diff", "nope..feature"])).code).toBe(ExitCode.Usage);
});
