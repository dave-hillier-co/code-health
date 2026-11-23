import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { historyDefaults } from "@code-health/cli-kit/config";
import { ExitCode } from "@code-health/cli-kit/errors";
import { runInProcess } from "@code-health/fixtures/cli-testing";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { cli } from "../src/cli.ts";
import { expectGolden } from "./support/golden.ts";
import { buildFixRepo, evidenceHistory, finalBilling, fixHistory, landedHistory, outsideHistory } from "./support/fix-history.ts";
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

interface Evidence {
  sha: string;
  date: string;
  subject: string;
  pattern: string;
  matchedIn: string;
}

interface Row {
  path: string;
  unit: string;
  id: string;
  score: number;
  fixCommits: number;
  unitRevisions: number;
  fixShare: number;
  reviewFixes: number;
  cognitive: number | null;
  labels: string[];
  evidence: Evidence[];
  evidenceOmitted: number;
  earlierIds: string[];
}

async function fixes(repo: GitFixture, ...args: string[]) {
  const run = await runComplexity(repo.path, ["fixes", "--json", "--limit", "all", ...args]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  const document = JSON.parse(run.stdout);
  return { ...run, document, rows: document.results as Row[] };
}

test("counts the fix commits that changed each function, follows a renamed function in a renamed file, and matches its golden", async () => {
  const repo = fixRepo();
  const run = await fixes(repo);
  expectGolden("fix-history", "fixes", run.stdout);

  // Hand-counted from the commits: see support/fix-history.ts.
  const price = run.rows.find((row) => row.id === "src/billing.ts#priceOrder")!;
  expect([price.fixCommits, price.unitRevisions, price.fixShare]).toEqual([2, 5, 0.4]);
  expect(price.earlierIds).toEqual(["src/orders.ts#price"]);
  expect(price.cognitive).toBe(8);
  const describe = run.rows.find((row) => row.id === "src/billing.ts#describe")!;
  expect([describe.fixCommits, describe.unitRevisions, describe.fixShare]).toEqual([1, 2, 0.5]);
  expect(run.rows.map((row) => row.id)).toEqual(["src/billing.ts#priceOrder", "src/billing.ts#describe"]);
});

test("lists the evidence commits newest first with the pattern that matched, up to --evidence, and says how many it left out", async () => {
  const run = await fixes(fixRepo(), "--evidence", "1");
  const price = run.rows.find((row) => row.unit === "priceOrder")!;
  expect(price.evidence).toHaveLength(1);
  expect(price.evidence[0]).toMatchObject({ date: "2024-02-10", subject: "Fix vip rate in priceOrder", pattern: historyDefaults.fixPatterns[2], matchedIn: "subject" });
  expect(price.evidence[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
  expect(price.evidenceOmitted).toBe(1);

  const all = await fixes(fixRepo(), "--evidence", "5");
  expect(all.rows.find((row) => row.unit === "priceOrder")!.evidence.map((entry) => entry.subject)).toEqual(["Fix vip rate in priceOrder", "Fix coupon rounding bug"]);
  expect(all.rows.find((row) => row.unit === "priceOrder")!.evidenceOmitted).toBe(0);
});

test("lists a function that was deleted apart from the rows, and counts it", async () => {
  const { document, rows } = await fixes(fixRepo());
  expect(rows.some((row) => row.unit === "legacy")).toBe(false);
  expect(document.deleted).toMatchObject({ units: 1, withFixes: 1, omitted: 0 });
  const [legacy] = document.deleted.rows as Row[];
  expect(legacy).toMatchObject({ id: "src/orders.ts#legacy", fixCommits: 1, unitRevisions: 2, fixShare: 0.5, cognitive: null });
});

test("counts a fix that changed only lines outside every function against the file", async () => {
  const { document } = await fixes(fixRepo());
  expect(document.outsideUnits).toMatchObject({ fixCommits: 2, files: 1, omitted: 0 });
  expect(document.outsideUnits.rows).toEqual([{ path: "src/billing.ts", fixCommits: 2, revisions: expect.any(Number) }]);
});

test("reports how many commits were analysed and skipped, and what bounded the work", async () => {
  const all = await fixes(fixRepo());
  expect(all.document.commits).toEqual({ inWindow: 11, analysed: 11, skipped: 0, skippedBy: { maxCommits: 0, oversized: 0, noSourceFile: 0 }, maxCommits: null });

  const bounded = await fixes(fixRepo(), "--max-commits", "3");
  expect(bounded.document.commits).toEqual({ inWindow: 11, analysed: 3, skipped: 8, skippedBy: { maxCommits: 8, oversized: 0, noSourceFile: 0 }, maxCommits: 3 });
  // The three newest commits are the removal, the second priceOrder fix and the rename, so only the fix of priceOrder is left.
  expect(bounded.rows.map((row) => [row.unit, row.fixCommits])).toEqual([["priceOrder", 1]]);
});

test("analyses the whole window by default, and --max-commits all says so", async () => {
  const repo = fixRepo();
  const run = await fixes(repo, "--max-commits", "all");
  expect(run.document.inputs.maxCommits).toBeNull();
  expect(run.document.commits.skippedBy.maxCommits).toBe(0);
  const bounded = await runInProcess(cli, repo.path, ["fixes", "--max-commits", "3", "--limit", "all"], true);
  expect(bounded.stdout).toMatch(/Only the newest 3 of 11 commits in the window were analysed: 8 older commits were left out by --max-commits 3/);
  const whole = await runInProcess(cli, repo.path, ["fixes", "--limit", "all"], true);
  expect(whole.stdout).not.toMatch(/Only the newest/);
  const refused = await runComplexity(repo.path, ["fixes", "--max-commits", "none"]);
  expect(refused.code).toBe(ExitCode.Usage);
});

test("counts a fix that a pattern matched and an exclude pattern removed as excluded, with the pattern, and not as a fix", async () => {
  const repo = fixRepo();
  repo.commit({ message: "Fix typo in the legacy comment", date: "2024-02-12T12:00:00+00:00", changes: [{ op: "modify", path: "src/billing.ts", content: finalBilling("// Order totals, in euro.") }] });
  const { document, rows } = await fixes(repo);
  expect(document.fixesExcluded).toMatchObject({ fixes: 1, byPattern: [{ count: 1 }] });
  expect(document.fixesExcluded.commits[0]).toMatchObject({ subject: "Fix typo in the legacy comment" });
  expect(document.fixesExcluded.commits[0].pattern).toContain("typos?");
  expect(document.fixConvention.fixes).toBe(6);
  expect(rows.find((row) => row.unit === "priceOrder")!.fixCommits).toBe(2);
});

test("labels a function with fewer than 3 revisions low evidence, and sorts it after the others with the same fix count", async () => {
  const repo = GitFixture.build([...fixHistory, ...evidenceHistory]);
  repos.push(repo);
  const { rows, document } = await fixes(repo);
  expect(document.lowEvidence.minRevisions).toBe(3);
  const ones = rows.filter((row) => row.fixCommits === 1);
  const steady = rows.find((row) => row.unit === "steady")!;
  const tiny = rows.find((row) => row.unit === "tiny")!;
  expect([steady.unitRevisions, steady.fixShare, steady.labels]).toEqual([4, 0.25, []]);
  expect([tiny.unitRevisions, tiny.fixShare, tiny.labels]).toEqual([2, 0.5, ["low evidence"]]);
  expect(ones.map((row) => row.unit)).toEqual(["steady", "describe", "tiny"]);
  expect(rows[0]!.unit).toBe("priceOrder");
});

test("outsideUnits.fixCommits counts each fix once however many files it touched, and never exceeds the fixes", async () => {
  const repo = GitFixture.build([...fixHistory, ...outsideHistory]);
  repos.push(repo);
  const { document } = await fixes(repo);
  // Two fixes outside functions in billing.ts, and one change that touched src/rates.ts and src/limits.ts outside any function.
  expect(document.outsideUnits.files).toBe(3);
  expect(document.outsideUnits.fixFileChanges).toBe(4);
  expect(document.outsideUnits.fixCommits).toBe(3);
  expect(document.outsideUnits.fixCommits).toBeLessThanOrEqual(document.fixConvention.fixes);
});

test("a commit that touches no source file is skipped and counted", async () => {
  const repo = fixRepo();
  repo.commit({ message: "Fix the readme", date: "2024-02-12T12:00:00+00:00", changes: [{ op: "modify", path: "README.md", content: "# Shop\n\nFixed.\n" }] });
  const { document } = await fixes(repo);
  expect(document.commits).toMatchObject({ inWindow: 12, analysed: 11, skipped: 1, skippedBy: { noSourceFile: 1 } });
});

test("puts the convention check in the header: the forms the landed titles use decide it, and the share is beside them", async () => {
  const { document } = await fixes(fixRepo());
  expect(document.fixConvention).toMatchObject({ landedChanges: 11, fixes: 6, followsConvention: true, note: null });
  expect(document.fixConvention.forms.fixVerb).toBeGreaterThan(0);
  expect(document.fixConvention.share).toBeCloseTo(6 / 11, 3);
});

test("a rerun parses nothing, because historical blobs are cached by blob", async () => {
  const repo = fixRepo();
  const first = await fixes(repo);
  expect(first.document.cache.parsed).toBeGreaterThan(0);
  const second = await fixes(repo, "--no-cache");
  expect(second.document.cache.parsed).toBe(0);
  expect(second.document.cache.cached).toBe(first.document.cache.parsed + first.document.cache.cached);
  expect(second.rows).toEqual(first.rows);
});

test("a run on a clean tree stores complexity.fixes for other plugins, and the same run prints the stored result", async () => {
  const repo = fixRepo();
  const first = await fixes(repo);
  const stored = JSON.parse(readFileSync(join(repo.path, ".cache", "code-health", "reports", "complexity.fixes.json"), "utf8"));
  expect(stored).toMatchObject({ tool: "complexity", command: "fixes", repo: { head: repo.git("rev-parse", "HEAD").trim(), dirty: false } });
  const again = await fixes(repo);
  expect(again.rows).toEqual(first.rows);
  // A run for one path states its input, so it never replaces the plain report other plugins read.
  await fixes(repo, "src/billing.ts");
  expect(JSON.parse(readFileSync(join(repo.path, ".cache", "code-health", "reports", "complexity.fixes.json"), "utf8")).inputs.paths).toEqual([]);
});

test("selects files by path argument", async () => {
  const repo = fixRepo();
  const none = await fixes(repo, "src/other");
  expect(none.rows).toEqual([]);
  expect(none.document.commits.inWindow).toBe(0);
  const some = await fixes(repo, "src/billing.ts");
  expect(some.rows).toHaveLength(2);
});

test("prints the header as notices after a table of rows by fix count", async () => {
  const run = await runInProcess(cli, fixRepo().path, ["fixes", "--limit", "all"], true);
  expect(run.code).toBe(ExitCode.Success);
  expect(run.stdout).toMatch(/priceOrder\s+production\s+2\s+5\s+0\.4/);
  expect(run.stdout.indexOf("priceOrder")).toBeLessThan(run.stdout.indexOf("describe"));
  expect(run.stdout).not.toContain("probably do not follow a convention");
  expect(run.stdout).toContain("Notice: Analysed 11 of 11 commits in the 12 month window and skipped 0");
});

test("rejects an option that is not a count", async () => {
  const run = await runComplexity(fixRepo().path, ["fixes", "--max-commits", "0"]);
  expect(run.code).toBe(ExitCode.Usage);
  expect(run.stderr).toContain("--max-commits");
});

test("describes the rule", async () => {
  const run = await runComplexity(fixRepo().path, ["explain", "fixes"]);
  expect(run.code).toBe(ExitCode.Success);
  expect(run.stdout).toContain("fixCommits is the landed changes that were fixes");
});

test("counts a landed change by its own title, and lists the fixes made on a branch before it merged apart from the fixes", async () => {
  const repo = GitFixture.build(landedHistory);
  repos.push(repo);
  const { rows, document } = await fixes(repo);
  const crashy = rows.find((row) => row.unit === "crashy")!;
  // Two landed changes after the one that created the file: a squash titled Fix, and a merge whose title says Fix though its branch commit says Tidy.
  expect([crashy.fixCommits, crashy.unitRevisions]).toEqual([2, 3]);
  expect(crashy.evidence.map((entry) => entry.subject)).toEqual(["Fix the null check", "Fix crash (#12)"]);
  expect(crashy.reviewFixes).toBe(0);
  // The branch commit "fix: review comments" is in a landed change titled "Add retries", so the function has no fix, and one fix during review.
  expect(rows.find((row) => row.unit === "reviewed")).toBeUndefined();
  const analysed = JSON.parse((await runComplexity(repo.path, ["analyse", "--json", "--with-fixes", "--limit", "all"])).stdout).results as { unit: string; fixCommits: number; unitRevisions: number; reviewFixes: number }[];
  expect(analysed.find((row) => row.unit === "reviewed")).toMatchObject({ fixCommits: 0, unitRevisions: 2, reviewFixes: 1 });
  expect(document.fixConvention).toMatchObject({ landedChanges: 4, fixes: 2, followsConvention: true });
});
