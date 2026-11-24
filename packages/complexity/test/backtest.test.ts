import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture, type Change, type Step } from "@code-health/fixtures/git-fixture";
import { MEASURES, OUTCOMES, correlate, partial, pearson, ranks, spearman, type FileSample } from "../src/backtest.ts";
import { expectGolden } from "./support/golden.ts";
import { runComplexity } from "./support/run.ts";

describe("rank correlations", () => {
  test("tied values share the mean of the ranks they span", () => {
    expect(ranks([10, 30, 20, 30])).toEqual([1, 3.5, 2, 3.5]);
    expect(ranks([5, 5, 5])).toEqual([2, 2, 2]);
  });

  test("Spearman is 1 for any rising relationship, -1 for a falling one, and null with no variation", () => {
    expect(spearman([1, 2, 3, 4], [1, 10, 100, 1000])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [9, 7, 5, 0])).toBeCloseTo(-1);
    expect(spearman([1, 2, 3, 4], [3, 3, 3, 3])).toBeNull();
    expect(pearson([], [])).toBeNull();
  });

  test("a partial correlation removes what a third variable explains", () => {
    // y follows z, and x is z with one pair swapped: with z held fixed nothing of the link is left over in x's favour.
    const z = [1, 2, 3, 4, 5, 6];
    const x = [2, 1, 3, 4, 5, 6];
    const y = [1, 2, 3, 4, 5, 6];
    expect(pearson(x, y)).toBeGreaterThan(0.9);
    expect(partial(x, y, z)).toBeNull();
    // Here x carries what z does not: y is z plus x's own order.
    const own = [1, 2, 1, 2, 1, 2];
    const both = z.map((value, i) => value + own[i]! * 3);
    expect(partial(own, both, z)).toBeGreaterThan(0.9);
    expect(partial(z, both, z)).toBeNull();
  });
});

const file = (values: Partial<FileSample>): FileSample => ({ path: "a.ts", codeLines: 1, functions: 1, cyclomaticSum: 1, cyclomaticMean: 1, cyclomaticMax: 1, shareAbove: 0, cognitiveSum: 0, cognitiveMax: 0, indentation: 0, priorChanges: 0, hotspot: 0, changes: 0, linesChurned: 0, fixes: 0, ...values });

describe("correlate", () => {
  const period = (offset: number) => [1, 2, 3, 4, 5].map((n) => file({ codeLines: n * 10 + offset, cyclomaticMax: 6 - n, changes: n, linesChurned: n * n, fixes: n > 3 ? 1 : 0 }));

  test("gives one row per outcome and measure, within periods and never across them", () => {
    // The second period is ten times busier and larger, which would link size and change if the periods were pooled.
    const rows = correlate([period(0), period(1000).map((f) => ({ ...f, changes: f.changes * 10, linesChurned: f.linesChurned * 10 }))], 5, 4);
    expect(rows).toHaveLength(OUTCOMES.length * MEASURES.length);
    const of = (outcome: string, measure: string) => rows.find((row) => row.outcome === outcome && row.measure === measure)!;
    expect(of("changes", "codeLines")).toEqual({ outcome: "changes", measure: "codeLines", correlation: 1, partialOnCodeLines: null, fileSamples: 10, periods: 2 });
    expect(of("changes", "cyclomaticMax").correlation).toBe(-1);
    // A measure with no variation in any period has no correlation.
    expect(of("changes", "functions")).toMatchObject({ correlation: null, partialOnCodeLines: null, fileSamples: 10 });
  });

  test("lines per change covers the files that changed, fix share the files with enough changes, and a small period is left out", () => {
    const rows = correlate([period(0)], 2, 4);
    const of = (outcome: string) => rows.find((row) => row.outcome === outcome && row.measure === "codeLines")!;
    expect(of("linesPerChange").fileSamples).toBe(5);
    // Two files have four or more changes, and both have one fix: fix shares of 1/4 and 1/5.
    expect(of("fixShare")).toMatchObject({ fileSamples: 2, correlation: -1 });
    expect(correlate([period(0)], 6, 4).every((row) => row.fileSamples === 0 && row.correlation === null && row.periods === 0)).toBe(true);
  });
});

const FILES = 24;
const path = (i: number) => `src/m${String(i).padStart(2, "0")}.ts`;
/** A function with `branches` if statements, and `extra` constants after it. */
const source = (i: number, extra: number) =>
  `export function f${i}(n: number): number {\n${Array.from({ length: i }, (_, b) => `  if (n === ${b}) return ${b * 2};\n`).join("")}  return n;\n}\n${Array.from({ length: extra }, (_, e) => `export const c${e} = ${e};\n`).join("")}`;

/**
 * 24 files, file i with i branches, and eleven monthly changes. Change k touches the files from index
 * `5k mod 12` up, so a larger file is changed in more months, and adds one to three lines to each depending on
 * the file. Every third change is a fix.
 */
function grownOverAYear(): GitFixture {
  const touched = new Array<number>(FILES).fill(0);
  const steps: Step[] = [{ type: "commit", message: "Add the modules", date: "2024-01-02T09:00:00Z", changes: Array.from({ length: FILES }, (_, i): Change => ({ op: "add", path: path(i), content: source(i, 0) })) }];
  for (let k = 1; k <= 11; k++) {
    const changes: Change[] = [];
    for (let i = (5 * k) % 12; i < FILES; i++) changes.push({ op: "modify", path: path(i), content: source(i, (touched[i]! += (i % 3) + 1)) });
    steps.push({ type: "commit", message: k % 3 === 0 ? `Fix the rounding bug in month ${k}` : `Extend the modules in month ${k}`, date: `2024-${String(k + 1).padStart(2, "0")}-02T09:00:00Z`, changes });
  }
  return GitFixture.build(steps);
}

describe("complexity backtest", () => {
  let repo: GitFixture;
  let stdout: string;
  let document: { inputs: { revisions: string[] }; evidence: { grade: string }; results: { periods: { from: string; to: string; files: number; landedChanges: number; oversizedSkipped: number }[]; correlations: { outcome: string; measure: string; correlation: number | null; partialOnCodeLines: number | null; fileSamples: number; periods: number }[]; minFiles: number } };
  const run = (...args: string[]) => runComplexity(repo.path, ["backtest", ...args]);
  const of = (outcome: string, measure: string) => document.results.correlations.find((row) => row.outcome === outcome && row.measure === measure)!;

  beforeAll(async () => {
    repo = grownOverAYear();
    const result = await run("--samples", "4", "--months", "11");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(ExitCode.Success);
    stdout = result.stdout;
    document = JSON.parse(stdout);
  }, 120_000);
  afterAll(() => repo.dispose());

  test("matches its golden output, which the schema check validates", () => {
    expectGolden("backtest", "backtest", stdout);
  });

  test("each sample but the last starts a period that ends at the next", () => {
    expect(document.inputs.revisions).toHaveLength(4);
    expect(document.inputs.revisions.at(-1)).toBe(repo.git("rev-parse", "HEAD"));
    expect(document.results.periods.map((period) => [period.from, period.to, period.files])).toEqual([
      ["2024-01-02", "2024-04-02", FILES],
      ["2024-04-02", "2024-08-02", FILES],
      ["2024-08-02", "2024-12-02", FILES],
    ]);
    // Eleven changes after the first sample, none with more files than the maximum changeset size.
    expect(document.results.periods.reduce((sum, period) => sum + period.landedChanges, 0)).toBe(11);
    expect(document.results.periods.every((period) => period.oversizedSkipped === 0)).toBe(true);
  });

  test("the larger files were changed more, and with code lines held fixed the complexity measures add nothing", () => {
    expect(of("changes", "codeLines")).toMatchObject({ partialOnCodeLines: null, fileSamples: FILES * 3, periods: 3 });
    expect(of("changes", "codeLines").correlation).toBeGreaterThan(0.7);
    // Each file is one function whose branches are its lines, so the largest complexity orders the files as code lines does at the first sample.
    expect(of("changes", "cyclomaticMax").correlation).toBeGreaterThan(0.7);
    expect(of("changes", "functions").correlation).toBeNull();
  });

  test("prior changes are counted over a period before the sample as long as the one after", () => {
    // The first sample is the first commit, so nothing precedes it; the later samples have history behind them.
    expect(of("changes", "priorChanges")).toMatchObject({ fileSamples: FILES * 3, periods: 3 });
    expect(of("changes", "priorChanges").correlation).toBeGreaterThan(0.5);
    expect(of("changes", "hotspot").correlation).toBeGreaterThan(0.5);
  });

  test("lines per change covers the files that changed, and fix share needs a period with enough busy files", () => {
    const perChange = of("linesPerChange", "codeLines");
    expect(perChange.fileSamples).toBeGreaterThanOrEqual(document.results.minFiles);
    expect(perChange.fileSamples).toBeLessThan(FILES * 3);
    expect(perChange.correlation).not.toBeNull();
    // No period has twenty files with three or more changes, so there is no fix share.
    expect(of("fixShare", "codeLines")).toMatchObject({ correlation: null, periods: 0, fileSamples: 0 });
  });

  test("it is left out of the tool's help, describes itself, and refuses bad options", async () => {
    const help = await runComplexity(repo.path, ["--help"]);
    expect(help.stdout).toContain("analyse");
    expect(help.stdout).not.toContain("backtest");
    expect((await run("--help")).stdout).toContain("--samples <samples>");
    for (const args of [["--samples", "2"], ["--samples", "61"], ["--months", "0"], ["--months", "soon"], ["extra"]]) {
      expect((await run(...args)).code).toBe(ExitCode.Usage);
    }
  });
});
