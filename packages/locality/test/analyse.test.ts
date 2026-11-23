import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { reportPath } from "../src/reports.ts";
import { ruleDescriptions } from "../src/rules.ts";
import { expectGolden, withoutMeta, withoutMetaOnly } from "./support/golden.ts";
import { runLocality } from "./support/run.ts";
import { distantHelpers } from "./support/scenarios.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = distantHelpers();
});
afterAll(() => repo.dispose());
beforeEach(() => {
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
});

interface Row {
  path: string;
  recommendation: string;
  rule: string;
  target: string;
  location: string;
  gain: number;
  fanIn: number;
  unit: { kind: string; files: string[]; tests: string[]; cycle: boolean };
  signals: { name: string; detail: string }[];
  blockers: { path: string; from: string[]; kind: string; unblockedGain: number }[];
  cohesion?: { mixed: boolean; components: { symbols: string[]; target: string; recommendation: string }[] };
  testRefs: { owned: string[]; external: string[] };
}

async function analyse(...args: string[]) {
  const { code, stdout, stderr } = await runLocality(repo.path, ["analyse", "--limit", "all", ...args]);
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  const document = JSON.parse(stdout);
  const rows = document.results as Row[];
  return { stdout, document, rows, row: (path: string) => rows.find((r) => r.path === path) as Row };
}

test("a helper with two consumers moves to the best of their ancestors that is not a grouping folder", async () => {
  const { row } = await analyse();
  expect(row("src/shared/utils/money.ts")).toMatchObject({
    recommendation: "move",
    rule: "two-consumers",
    location: "src/shared/utils",
    target: "src/billing",
    gain: 4,
    fanIn: 2,
  });
});

test("a tiny helper with one consumer is inlined, and its own test is carried with it", async () => {
  const { row } = await analyse();
  const slug = row("src/shared/utils/slug.ts");
  expect(slug).toMatchObject({ recommendation: "inline", rule: "single-consumer-tiny", target: "src/orders", fanIn: 1 });
  expect(slug.unit.tests).toEqual(["src/shared/utils/slug.test.ts"]);
  expect(slug.testRefs).toEqual({ owned: ["src/shared/utils/slug.test.ts"], external: [] });
});

test("a large helper with one consumer moves next to it as its own module", async () => {
  const { row } = await analyse();
  expect(row("src/shared/utils/invoice.ts")).toMatchObject({
    recommendation: "move",
    rule: "single-consumer-large",
    target: "src/billing",
  });
});

test("a pass-through with one consumer is inlined even beside its consumer", async () => {
  const { row } = await analyse();
  const audit = row("src/orders/audit.ts");
  expect(audit).toMatchObject({ recommendation: "inline", rule: "pass-through", gain: 0 });
  expect(audit.signals).toContainEqual({ name: "pass-through", detail: "audit" });
});

test("a barrel with one importing file is inlined on its own, without the branch behind it", async () => {
  const { row } = await analyse();
  expect(row("src/billing/index.ts")).toMatchObject({ recommendation: "inline", rule: "single-consumer-barrel" });
  expect(row("src/billing/index.ts").unit.files).toEqual(["src/billing/index.ts"]);
});

test("a file whose exports have disjoint consumers in different folders is split", async () => {
  const { row } = await analyse();
  const mixed = row("src/shared/helpers/mixed.ts");
  expect(mixed).toMatchObject({ recommendation: "split", rule: "mixed-exports" });
  expect(mixed.cohesion?.mixed).toBe(true);
  expect(mixed.cohesion?.components.map((c) => [c.symbols, c.target])).toEqual([
    [["invoiceLabel"], "src/billing"],
    [["orderLabel"], "src/orders"],
  ]);
  expect(mixed.signals).toContainEqual({ name: "vague-name", detail: "helpers" });
});

test("a heavily used formatter is scrutinised, not moved, and its flag parameter is a signal", async () => {
  const { row } = await analyse();
  const format = row("src/shared/format.ts");
  expect(format).toMatchObject({ recommendation: "scrutinise", rule: "high-fan-in", fanIn: 8 });
  expect(format.signals).toContainEqual({ name: "special-general-mixture", detail: "fmt(compact)" });
});

test("an import cycle moves as one unit", async () => {
  const { row } = await analyse();
  expect(row("src/shared/cycle/a.ts")).toMatchObject({
    recommendation: "move",
    target: "src/orders",
    unit: { kind: "branch", files: ["src/shared/cycle/a.ts", "src/shared/cycle/b.ts"], cycle: true },
  });
});

test("a unit held in place by its own dependency is blocked, with the gain it would have unblocked", async () => {
  const { row } = await analyse();
  const tool = row("src/lib/kernel/tool.ts");
  expect(tool).toMatchObject({ recommendation: "blocked", rule: "blocked-by-dependency", gain: 0 });
  expect(tool.blockers).toEqual([expect.objectContaining({ path: "src/lib/kernel/core.ts", from: ["src/lib/kernel/tool.ts"], kind: "stray", unblockedGain: 4 })]);
});

test("sibling files that share internals form a multi-entry unit, named by its folder", async () => {
  const { row, rows } = await analyse();
  expect(row("src/shared/pair")).toMatchObject({
    recommendation: "move",
    rule: "two-consumers",
    target: "src/reports",
    unit: { kind: "sibling-set", entries: ["src/shared/pair/a.ts", "src/shared/pair/b.ts"] },
  });
  expect(row("src/shared/pair").unit.files).toEqual(["src/shared/pair/a.ts", "src/shared/pair/b.ts", "src/shared/pair/core.ts"]);
  // Siblings that share nothing are not a unit of their own: their individual units already cover them.
  expect(rows.filter((r) => r.unit.kind === "sibling-set").map((r) => r.path)).toEqual(["src/shared/pair"]);
});

test("a branch whose files sit outside its entry's folder is reviewed, since its leaves are scored on their own", async () => {
  const { row } = await analyse();
  expect(row("src/orders/place.ts")).toMatchObject({ recommendation: "review", rule: "scattered-unit" });
});

test("unused exports are overexposed, and units already near their consumers are not listed", async () => {
  const { row, rows } = await analyse();
  expect(row("src/shared/utils/money.ts").signals).toContainEqual({ name: "overexposure", detail: "unusedExport" });
  expect(rows.map((r) => r.path)).not.toContain("src/features/feature1.ts");
  expect(rows.some((r) => r.rule === "near-consumers")).toBe(false);
});

test("files the entry point cannot reach are reported, and do not count as consumers", async () => {
  const { document, row } = await analyse();
  expect(document.unreachable).toEqual(["src/legacy/dead.ts"]);
  expect(row("src/shared/utils/money.ts").fanIn).toBe(2);
  expect(document.inputs).toMatchObject({ entrySource: "config", entries: ["src/main.ts"] });
});

test("results are ranked by ratio to the guideline, then score, then path", async () => {
  const { rows, document } = await analyse();
  expect(document.results.length).toBe(rows.length);
  const scored = document.results as { score: number; path: string; ranking: { ratio: number } }[];
  for (let i = 1; i < scored.length; i++) {
    const a = scored[i - 1]!;
    const b = scored[i]!;
    const ordered =
      a.ranking.ratio > b.ranking.ratio ||
      (a.ranking.ratio === b.ranking.ratio && (a.score > b.score || (a.score === b.score && a.path < b.path)));
    expect(ordered).toBe(true);
  }
});

test("--recommendation and path arguments filter, and filtered runs store no report", async () => {
  const blocked = await analyse("--recommendation", "blocked");
  expect(blocked.rows.every((r) => r.recommendation === "blocked")).toBe(true);
  expect(blocked.rows.map((r) => r.path)).toContain("src/lib/kernel/tool.ts");
  const orders = await analyse("src/shared/utils");
  expect(orders.rows.every((r) => r.path.startsWith("src/shared/utils/"))).toBe(true);
  expect(existsSync(reportPath(repo.path, "analyse"))).toBe(false);
});

test("a whole-repository run on a clean tree stores every result as reports/locality.analyse.json", async () => {
  const { stdout } = await runLocality(repo.path, ["analyse", "--limit", "3"]);
  const stored = readFileSync(reportPath(repo.path, "analyse"), "utf8");
  const printed = JSON.parse(stdout);
  const report = JSON.parse(stored);
  expect(printed.results.length).toBe(3);
  expect(report.results.length).toBe(printed.truncated.total);
  expect(report).toMatchObject({ tool: "locality", command: "analyse", repo: { head: printed.repo.head, dirty: false } });
  expect(report.meta).toBeUndefined();
  expect(stored).toBe(withoutMetaOnly(stored));
});

test("the stored report names its schemaVersion, which the structure plugin reads", async () => {
  await runLocality(repo.path, ["analyse", "--limit", "1"]);
  const report = JSON.parse(readFileSync(reportPath(repo.path, "analyse"), "utf8"));
  expect(report.schemaVersion).toBe(1);
});

test("candidates sort by how far each is past its own guideline, and a fan-in is read against highFanIn", async () => {
  const { rows } = await analyse();
  type Ranked = Row & { score: number; scoreUnit: string; ranking: { value: number; guideline: number; ratio: number } };
  const ranked = rows as Ranked[];
  const ratios = ranked.map((candidate) => candidate.ranking.ratio);
  expect(ratios).toEqual([...ratios].sort((a, b) => b - a));
  for (const candidate of ranked) {
    expect(candidate.ranking.value).toBe(candidate.score);
    expect(candidate.ranking.guideline).toBe(candidate.scoreUnit === "fan-in" ? 8 : 2);
  }
  expect(new Set(ranked.map((candidate) => candidate.scoreUnit)).size).toBeGreaterThan(1);
});

test("each unit shows its fan-in percentile among the repository's units, and the most used unit is at 100", async () => {
  const { rows } = await analyse();
  const percentiles = rows.map((candidate) => ({ fanIn: candidate.fanIn, percentile: (candidate as Row & { fanInPercentile: number }).fanInPercentile }));
  const sorted = [...percentiles].sort((a, b) => a.fanIn - b.fanIn);
  for (let index = 1; index < sorted.length; index++) expect(sorted[index]!.percentile).toBeGreaterThanOrEqual(sorted[index - 1]!.percentile);
  expect(sorted.at(-1)!.percentile).toBe(100);
  expect(percentiles.every((entry) => Number.isInteger(entry.percentile) && entry.percentile >= 0 && entry.percentile <= 100)).toBe(true);
});

test("the output is byte for byte reproducible", async () => {
  const first = (await analyse()).stdout;
  const second = (await analyse()).stdout;
  expect(withoutMeta(first)).toBe(withoutMeta(second));
  expectGolden("distant-helpers", "analyse", first);
});

test("explain describes every rule the analyser can name", async () => {
  const { stdout } = await runLocality(repo.path, ["explain"]);
  for (const rule of ["single-consumer-tiny", "two-consumers", "high-fan-in", "mixed-exports", "blocked-by-dependency", "independent-consumers", "consumers-co-change", "within-grace-period", "creates-cycle"]) {
    expect(stdout).toContain(rule);
  }
  const { stdout: one } = await runLocality(repo.path, ["explain", "pass-through"]);
  expect(one).toMatch(/^pass-through: /);
});

test.each(["inline", "move", "split", "blocked", "scrutinise", "review"])("the %s candidates match their golden", async (recommendation) => {
  const { stdout, rows } = await analyse("--recommendation", recommendation);
  expect(rows.length).toBeGreaterThan(0);
  expectGolden("distant-helpers", `analyse.${recommendation}`, stdout);
});

test.each(Object.keys(ruleDescriptions))("explain %s prints the rule's summary and its explanation", async (rule) => {
  const run = await runLocality(repo.path, ["explain", rule]);
  expect(run.code).toBe(ExitCode.Success);
  expect(run.stdout).toBe(`${rule}: ${ruleDescriptions[rule]!.summary}\n\n${ruleDescriptions[rule]!.explanation}\n`);
});
