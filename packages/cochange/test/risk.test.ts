import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { body, invoice, invoiceTest, riskHistory, tax } from "./support/risk-scenario.ts";
import { expectGolden } from "./support/golden.ts";
import { runCochange } from "./support/run.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = riskHistory();
}, 60_000);
afterAll(() => repo.dispose());
beforeEach(() => {
  rmSync(join(repo.path, "code-health.json"), { force: true });
  repo.git("checkout", "--quiet", "main");
});

interface Factor {
  name: string;
  status: string;
  band: string | null;
  scored: boolean;
  value: Record<string, unknown>;
  thresholds: Record<string, unknown>;
  evidence: Record<string, unknown>[];
  reason: string | null;
}
interface Assessment {
  kind: string;
  change: Record<string, unknown> & { paths: { path: string; status: string }[] };
  impact: { band: string; score: number; scoreBand: string; events: string[]; baseline: { population: number } };
  factors: Factor[];
}

async function risk(...args: string[]): Promise<{ code: number; stderr: string; document: { inputs: Record<string, any>; results: Assessment } }> {
  const { code, stdout, stderr } = await runCochange(repo.path, ["risk", ...args, "--json"]);
  return { code, stderr, document: stdout === "" ? (undefined as never) : JSON.parse(stdout) };
}

const factor = (assessment: Assessment, name: string): Factor => {
  const found = assessment.factors.find((f) => f.name === name);
  if (!found) throw new Error(`no factor ${name}`);
  return found;
};

test("a branch is measured as one change from its merge base, with its files filtered and counted", async () => {
  const { code, document } = await risk("main..complete");
  expect(code).toBe(ExitCode.Success);
  expect(document.results.kind).toBe("assessment");
  expect(document.results.change).toMatchObject({ commits: 1, files: 3, added: 40, deleted: 40, moved: 0, worktree: false, against: "main" });
  expect(document.results.change.paths.map((p) => p.path)).toEqual([invoiceTest, invoice, tax].sort());
});

test("the base defaults to the merge base with the main branch, and the range is optional", async () => {
  repo.git("checkout", "--quiet", "missing");
  const defaulted = await risk();
  const explicit = await risk("main..missing");
  expect(defaulted.document.results.change).toEqual(explicit.document.results.change);
  expect(defaulted.document.results.factors).toEqual(explicit.document.results.factors);
});

test("size, spread and entropy are computed from the change's own churn and paths", async () => {
  const { document } = await risk("main..bulk");
  expect(factor(document.results, "size").value).toEqual({ lines: 360, files: 12 });
  // 12 files, two in each of six folders: 6 pairs at distance 0 and 60 at distance 2.
  expect(factor(document.results, "spread").value).toEqual({ spread: 1.818182, folders: 6, components: null });
  expect(factor(document.results, "entropy").value).toEqual({ entropy: 3.584963, files: 12 });
  const complete = (await risk("main..complete")).document.results;
  expect(factor(complete, "size").value).toEqual({ lines: 80, files: 3 });
  // Churn 40, 20 and 20 over three files: 0.5, 0.25 and 0.25.
  expect(factor(complete, "entropy").value).toEqual({ entropy: 1.5, files: 3 });
  expect(factor(complete, "entropy").band).toBe("low");
});

test("a change much larger than the repository's merged changes is high on size, spread and entropy", async () => {
  const { document } = await risk("main..bulk");
  for (const name of ["size", "spread", "entropy"]) expect(factor(document.results, name).band, name).toBe("high");
  expect(factor(document.results, "size").thresholds).toEqual({ lines: { moderate: expect.any(Number), high: expect.any(Number) } });
});

test("a change that leaves out the files that always change with its file reports each as missing", async () => {
  const { document } = await risk("main..missing");
  const missing = factor(document.results, "missing-co-change");
  expect(missing.value).toEqual({ count: 2 });
  // The invoice changed seven times, six of them with tax and with its test: 6/7 = 85.7 %.
  expect(missing.evidence).toEqual([
    { file: invoiceTest, towards: invoice, confidence: 85.7, support: 6 },
    { file: tax, towards: invoice, confidence: 85.7, support: 6 },
  ]);
  expect(missing.band).toBe("moderate");
});

test("a complete change has nothing missing", async () => {
  const { document } = await risk("main..complete");
  const missing = factor(document.results, "missing-co-change");
  expect(missing.value).toEqual({ count: 0 });
  expect(missing.band).toBe("low");
});

test("missing files are counted at the configured confidence, and a threshold above the observed one finds none", async () => {
  writeFileSync(join(repo.path, "code-health.json"), '{"cochange":{"risk":{"missingConfidence":90}}}\n');
  const { document } = await risk("main..missing");
  expect(factor(document.results, "missing-co-change").value).toEqual({ count: 0 });
});

test("the support minimum applies: files that changed together fewer times are not expected", async () => {
  writeFileSync(join(repo.path, "code-health.json"), '{"cochange":{"minSupport":7}}\n');
  const { document } = await risk("main..missing");
  expect(factor(document.results, "missing-co-change").value).toEqual({ count: 0 });
});

test("a move combined with a content change is mixed purpose, and its evidence names the move", async () => {
  const { document } = await risk("main..mixed");
  expect(document.results.change).toMatchObject({ moved: 1, files: 1 });
  const mixed = factor(document.results, "mixed-purpose");
  expect(mixed.value).toEqual({ moved: 1, edited: 1, editedWhileMoved: 0 });
  expect(mixed.band).toBe("moderate");
});

test("a pure move on its own is not mixed purpose", async () => {
  repo.git("checkout", "--quiet", "-b", "only-move", "main");
  mkdirSync(join(repo.path, "src/reporting"), { recursive: true });
  repo.git("mv", "src/reports/summary.ts", "src/reporting/summary.ts");
  repo.git("-c", "user.name=Alice", "-c", "user.email=alice@example.com", "commit", "--quiet", "-m", "Move");
  const { document } = await risk("main..only-move");
  expect(document.results.change).toMatchObject({ moved: 1, files: 0 });
  expect(factor(document.results, "mixed-purpose").band).toBe("low");
});

test("a sensitive path is reported and, as an event, raises the impact band once", async () => {
  const { document } = await risk("main..auth");
  expect(factor(document.results, "sensitive-paths").evidence).toEqual([{ file: "src/auth/login.ts" }]);
  expect(document.results.impact.scoreBand).toBe("low");
  expect(document.results.impact.events).toEqual(["sensitive-paths"]);
  expect(document.results.impact.band).toBe("moderate");
});

test("a factor that cannot be computed is unavailable and has no band, never low", async () => {
  const { document } = await risk("main..complete");
  const defects = factor(document.results, "defect-history");
  expect(defects.status).toBe("unavailable");
  expect(defects.band).toBeNull();
  expect(defects.reason).toMatch(/baseline/);
});

test("the baseline is the repository's merged changes, merges and single commits alike", async () => {
  const { document } = await risk("main..complete");
  expect(document.inputs.baseline).toMatchObject({ mergedChanges: 16, merges: 2, direct: 14, population: 16 });
  expect(document.results.impact.baseline.population).toBe(16);
});

test("work merged to main after the branch point does not change the branch's score", async () => {
  const before = (await risk("main..missing")).document.results;
  repo.commit({
    message: "Later work on tax",
    date: "2024-06-20T09:00:00Z",
    changes: [
      { op: "modify", path: tax, content: body(tax, 10, 99) },
      { op: "modify", path: "README.md", content: body("README.md", 5, 99) },
    ],
  });
  const after = (await risk("main~1..missing")).document.results;
  const sameBranch = (await risk("missing~1..missing")).document.results;
  expect(after.factors).toEqual(before.factors);
  expect(sameBranch.factors).toEqual(before.factors);
});

test("uncommitted edits join the change only with --worktree", async () => {
  repo.git("checkout", "--quiet", "missing");
  writeFileSync(join(repo.path, tax), body(tax, 10, 77));
  const without = (await risk()).document.results;
  const withEdits = (await risk("--worktree")).document.results;
  expect(without.change).toMatchObject({ files: 1, worktree: false });
  expect(withEdits.change).toMatchObject({ files: 2, worktree: true });
  // Tax is now touched, so it is no longer missing.
  expect(factor(withEdits, "missing-co-change").evidence.map((e) => e.file)).toEqual([invoiceTest]);
  repo.git("checkout", "--quiet", "--", tax);
});

test("a branch with nothing of its own is an empty change, not an error", async () => {
  const { code, document } = await risk("main..main");
  expect(code).toBe(ExitCode.Success);
  expect(document.results.change).toMatchObject({ commits: 0, files: 0 });
  expect(document.results.impact.band).toBe("low");
});

test("usage errors exit 2: an unknown ref, a ref with no common ancestor, and --worktree on another tip", async () => {
  expect((await risk("nonesuch..missing")).code).toBe(ExitCode.Usage);
  expect((await risk("main..nonesuch")).code).toBe(ExitCode.Usage);
  expect((await risk("main..missing", "--worktree")).code).toBe(ExitCode.Usage);
  expect((await risk("a", "b")).code).toBe(ExitCode.Usage);
});

test("a factor can be switched off, and then it neither bands nor counts", async () => {
  writeFileSync(join(repo.path, "code-health.json"), '{"cochange":{"risk":{"disable":["size"]}}}\n');
  const { document } = await risk("main..bulk");
  const size = factor(document.results, "size");
  expect(size).toMatchObject({ status: "disabled", band: null, scored: false, value: {} });
});

test("bad risk settings are config errors", async () => {
  writeFileSync(join(repo.path, "code-health.json"), '{"cochange":{"risk":{"moderatePercentile":95,"highPercentile":90}}}\n');
  expect((await risk("main..missing")).code).toBe(ExitCode.Usage);
  writeFileSync(join(repo.path, "code-health.json"), '{"cochange":{"risk":{"disable":["nonesuch"]}}}\n');
  expect((await risk("main..missing")).code).toBe(ExitCode.Usage);
});

test("the assessment of a change that misses its coupled files, byte for byte", async () => {
  const { stdout } = await runCochange(repo.path, ["risk", "main..missing"]);
  expectGolden("risk", "risk.missing", stdout);
});

test("the assessment of a very large change, byte for byte", async () => {
  const { stdout } = await runCochange(repo.path, ["risk", "main..bulk"]);
  expectGolden("risk", "risk.bulk", stdout);
});

test("explain prints the rules behind the level and the factors, without reading the branch", async () => {
  const { code, document } = await risk("explain");
  expect(code).toBe(ExitCode.Success);
  const results = document.results as unknown as { kind: string; rules: { id: string }[]; factors: { name: string }[]; settings: Record<string, unknown> };
  expect(results.kind).toBe("explain");
  expect(results.rules.map((r) => r.id)).toEqual(["baseline", "bands", "unavailable", "families", "impact", "events", "placement", "level", "backtest"]);
  expect(results.factors.map((f) => f.name)).toContain("missing-co-change");
  expect(results.settings).toMatchObject({ moderatePercentile: 75, highPercentile: 90, countModerate: 1, countHigh: 3 });
});

test("explain of a factor gives its definition, thresholds and the files that drove it on the branch", async () => {
  repo.git("checkout", "--quiet", "missing");
  const { document } = await risk("explain", "missing-co-change");
  const results = document.results as unknown as { topic: string; doc: { definition: string }; branch: Factor };
  expect(results.topic).toBe("missing-co-change");
  expect(results.doc.definition).toMatch(/confidence/);
  expect(results.branch.thresholds).toEqual({ count: { moderate: 1, high: 3 } });
  expect(results.branch.evidence.map((e) => e.file)).toEqual([invoiceTest, tax]);
});

test("explain of a placement factor defines it and does not compute it", async () => {
  const { document } = await risk("explain", "authorship");
  const results = document.results as unknown as { branch: Factor | null; doc: { family: string } };
  expect(results.doc.family).toBe("placement");
  expect(results.branch).toBeNull();
});

test("explain of an unknown factor is a usage error that lists the factors", async () => {
  const { code, stderr } = await risk("explain", "nonesuch");
  expect(code).toBe(ExitCode.Usage);
  expect(stderr).toMatch(/size, spread, entropy/);
});

test("the rules behind the level, byte for byte", async () => {
  const { stdout } = await runCochange(repo.path, ["risk", "explain"]);
  expectGolden("risk", "risk.explain", stdout);
});

test("one factor explained on a branch, byte for byte", async () => {
  repo.git("checkout", "--quiet", "missing");
  const { stdout } = await runCochange(repo.path, ["risk", "explain", "missing-co-change"]);
  expectGolden("risk", "risk.explain-factor", stdout);
});
