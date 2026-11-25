import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadConfig } from "@code-health/cli-kit/config";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture, type Change, type Step } from "@code-health/fixtures/git-fixture";
import { findFix } from "@code-health/history/fix-commits";
import { readLandings } from "@code-health/history/landings";
import { firstParentLine, type Commit } from "@code-health/history/trend-samples";
import { GrammarSet } from "@code-health/parse/grammars";
import { ParseCache } from "@code-health/parse/parse-cache";
import { complexityConfig, readSettings } from "../src/config.ts";
import { functionSamples, type FunctionSamples } from "../src/function-backtest.ts";
import { expectGolden } from "./support/golden.ts";
import { runComplexity } from "./support/run.ts";

/** A function whose body is told apart from the others' by its operator and constant. */
const fn = (name: string, body: string) => `export function ${name}(n: number): number {\n  if (n > 1) {\n    return ${body};\n  }\n  return n;\n}\n`;

const alpha = fn("alpha", "n * 2");
const beta = fn("beta", "n + 3");
const gamma = fn("gamma", "n - 4");
const delta = fn("delta", "n / 5");

/**
 * Three samples on the first of March, July and November 2024. Before the first, the modules are added and alpha and beta
 * changed. In the first period: a fix changes alpha and adds zeta; a merged branch fixes delta and moves its file; beta is
 * renamed to bravo and then changed; gamma is deleted. In the second period zeta is fixed.
 */
const steps: Step[] = [
  { type: "commit", message: "Add the modules", date: "2024-01-01T09:00:00Z", changes: [{ op: "add", path: "src/a.ts", content: alpha + beta + gamma }, { op: "add", path: "src/b.ts", content: delta }] },
  { type: "commit", message: "Extend alpha", date: "2024-02-01T09:00:00Z", changes: [{ op: "modify", path: "src/a.ts", content: fn("alpha", "n * 20") + beta + gamma }] },
  { type: "commit", message: "Extend beta", date: "2024-03-01T09:00:00Z", changes: [{ op: "modify", path: "src/a.ts", content: fn("alpha", "n * 20") + fn("beta", "n + 30") + gamma }] },
  { type: "commit", message: "Fix the overflow in alpha", date: "2024-04-01T09:00:00Z", changes: [{ op: "modify", path: "src/a.ts", content: fn("alpha", "n * 21") + fn("beta", "n + 30") + gamma + fn("zeta", "n % 6") }] },
  { type: "branch", name: "feature" },
  { type: "commit", message: "Round delta down", date: "2024-04-15T09:00:00Z", changes: [{ op: "rename", from: "src/b.ts", path: "src/d.ts", content: fn("delta", "Math.floor(n / 5)") }] },
  { type: "checkout", name: "main" },
  { type: "merge", branch: "feature", message: "Merge pull request #1 from someone/feature\n\nFix the rounding of delta", date: "2024-05-01T09:00:00Z" },
  { type: "commit", message: "Rename beta to bravo", date: "2024-06-01T09:00:00Z", changes: [{ op: "modify", path: "src/a.ts", content: fn("alpha", "n * 21") + fn("bravo", "n + 30") + gamma + fn("zeta", "n % 6") }] },
  { type: "commit", message: "Extend bravo", date: "2024-06-15T09:00:00Z", changes: [{ op: "modify", path: "src/a.ts", content: fn("alpha", "n * 21") + fn("bravo", "n + 31") + gamma + fn("zeta", "n % 6") }] },
  { type: "commit", message: "Remove gamma", date: "2024-07-01T09:00:00Z", changes: [{ op: "modify", path: "src/a.ts", content: fn("alpha", "n * 21") + fn("bravo", "n + 31") + fn("zeta", "n % 6") }] },
  { type: "commit", message: "Fix the sign of zeta", date: "2024-11-01T09:00:00Z", changes: [{ op: "modify", path: "src/a.ts", content: fn("alpha", "n * 21") + fn("bravo", "n + 31") + fn("zeta", "-n % 6") }] },
];

describe("following functions through the history", () => {
  let repo: GitFixture;
  let followed: FunctionSamples;
  const at = (period: number, name: string) => followed.samples[period]!.find((sample) => sample.id.endsWith(`#${name}`))!;

  beforeAll(async () => {
    repo = GitFixture.build(steps);
    const settings = readSettings(loadConfig(repo.path, complexityConfig));
    const line = await firstParentLine(repo.path, "HEAD");
    const sampled = ["2024-03-01", "2024-07-01", "2024-11-01"].map((day) => line.findLast((commit) => new Date(commit.date * 1000).toISOString().startsWith(day))!) as Commit[];
    const priorStarts = sampled.slice(0, -1).map((from, i) => from.date - (sampled[i + 1]!.date - from.date));
    const counted = new Map((await readLandings(repo.path, "HEAD")).map((landing) => [landing.id, { fix: findFix(settings.fix, landing.id, [landing.text]) !== null }] as const));
    followed = await functionSamples(repo.path, settings, line, sampled, priorStarts, counted, { cache: await ParseCache.forRepository(repo.path), grammars: new GrammarSet() });
  }, 60_000);
  afterAll(() => repo.dispose());

  test("a change counts for the function whose lines it changed, a fix as a fix, and lines churned are the function's own", () => {
    expect(followed.samples[0]!.map((sample) => sample.id)).toEqual(["src/a.ts#alpha", "src/a.ts#beta", "src/a.ts#gamma", "src/b.ts#delta"]);
    // One line replaced: one added and one deleted. Adding zeta after alpha changed no line of alpha's.
    expect(at(0, "alpha")).toMatchObject({ changes: 1, linesChurned: 2, fixes: 1 });
  });

  test("a function is followed through a rename of its file on a merged branch, and the merge's title makes it a fix", () => {
    expect(at(0, "delta")).toMatchObject({ path: "src/b.ts", changes: 1, linesChurned: 2, fixes: 1 });
  });

  test("a function renamed in place is followed by its body, and its later changes count for it", () => {
    expect(at(0, "beta")).toMatchObject({ changes: 2, fixes: 0 });
  });

  test("a function deleted in a period ends there, and the deletion is not counted as a change to it", () => {
    expect(at(0, "gamma")).toMatchObject({ changes: 0, fixes: 0 });
    expect(followed.periods[0]).toEqual({ files: 2, functions: 4, ended: 1, notFollowed: 0 });
  });

  test("prior changes count the changes before the sample, the one that created the function included", () => {
    expect([at(0, "alpha").priorChanges, at(0, "beta").priorChanges, at(0, "gamma").priorChanges, at(0, "delta").priorChanges]).toEqual([2, 2, 1, 1]);
  });

  test("a fix that creates a function is a change to it and not a fix of it", () => {
    // zeta was created by the fix to alpha, in the period before the second sample, and fixed in the period after it.
    expect(at(1, "zeta")).toMatchObject({ priorChanges: 1, changes: 1, fixes: 1 });
    expect(followed.samples[1]!.map((sample) => sample.id)).toEqual(["src/a.ts#alpha", "src/a.ts#bravo", "src/a.ts#zeta", "src/d.ts#delta"]);
    // The period before the second sample is as long as the one after it, 123 days, so it starts on the 29th of February: beta's extension, its rename and bravo's extension.
    expect(at(1, "bravo").priorChanges).toBe(3);
  });
});

const FUNCTIONS = 24;
/** Function i with i branches, so the functions are told apart by cyclomatic complexity and code lines alike. */
const member = (i: number, extra: number) =>
  `export function f${i}(n: number): number {\n${Array.from({ length: i }, (_, b) => `  if (n === ${b}) return ${b * 2};\n`).join("")}${Array.from({ length: extra }, (_, e) => `  n += ${e};\n`).join("")}  return n;\n}\n`;
const module = (part: number, extras: readonly number[]) => Array.from({ length: FUNCTIONS / 2 }, (_, j) => member(part * (FUNCTIONS / 2) + j, extras[part * (FUNCTIONS / 2) + j]!)).join("\n");

/**
 * Two files of twelve functions each, so no file-level figure could rank the functions. Each of eleven monthly changes
 * touches the functions from index `5k mod 12` up and adds a line to each, so a larger function is changed in more months.
 * Every third change is a fix.
 */
function twoModules(): GitFixture {
  const extras = new Array<number>(FUNCTIONS).fill(0);
  const contents = (): Change[] => [0, 1].map((part) => ({ op: "modify", path: `src/m${part}.ts`, content: module(part, extras) }));
  const steps: Step[] = [{ type: "commit", message: "Add the modules", date: "2024-01-02T09:00:00Z", changes: contents().map((change) => ({ ...change, op: "add" }) as Change) }];
  for (let k = 1; k <= 11; k++) {
    for (let i = (5 * k) % 12; i < FUNCTIONS; i++) extras[i]!++;
    steps.push({ type: "commit", message: k % 3 === 0 ? `Fix the rounding bug in month ${k}` : `Extend the functions in month ${k}`, date: `2024-${String(k + 1).padStart(2, "0")}-02T09:00:00Z`, changes: contents() });
  }
  return GitFixture.build(steps);
}

describe("complexity backtest --unit function", () => {
  let repo: GitFixture;
  let stdout: string;
  type Row = { outcome: string; measure: string; correlation: number | null; partialOnCodeLines: number | null; functionSamples: number; periods: number; pooledSamples: number; pooledCorrelation: number | null };
  let document: { inputs: { unit: string }; results: { periods: { files: number; functions: number; ended: number; notFollowed: number; landedChanges: number }[]; matching: string; correlations: Row[] } };
  const of = (outcome: string, measure: string) => document.results.correlations.find((row) => row.outcome === outcome && row.measure === measure)!;

  beforeAll(async () => {
    repo = twoModules();
    const result = await runComplexity(repo.path, ["backtest", "--unit", "function", "--samples", "4", "--months", "11"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(ExitCode.Success);
    stdout = result.stdout;
    document = JSON.parse(stdout);
  }, 120_000);
  afterAll(() => repo.dispose());

  test("matches its golden output, which the schema check validates", () => {
    expectGolden("backtest", "backtest.functions", stdout);
  });

  test("each period counts the functions at its sample and says how they were followed", () => {
    expect(document.inputs.unit).toBe("function");
    expect(document.results.periods.map((period) => [period.files, period.functions, period.ended, period.notFollowed])).toEqual([
      [2, FUNCTIONS, 0, 0],
      [2, FUNCTIONS, 0, 0],
      [2, FUNCTIONS, 0, 0],
    ]);
    expect(document.results.matching).toContain("body similarity");
  });

  test("the larger functions were changed more, in files that every change touched", () => {
    expect(of("changes", "codeLines")).toMatchObject({ partialOnCodeLines: null, functionSamples: FUNCTIONS * 3, periods: 3 });
    expect(of("changes", "codeLines").correlation).toBeGreaterThan(0.7);
    expect(of("changes", "cyclomatic").correlation).toBeGreaterThan(0.7);
    expect(of("changes", "priorChanges").correlation).toBeGreaterThan(0.5);
  });

  test("fix share has no period with twenty busy functions, and the pooled figure rests on every period's", () => {
    expect(of("fixShare", "codeLines")).toMatchObject({ correlation: null, periods: 0, functionSamples: 0 });
    expect(of("fixShare", "codeLines").pooledSamples).toBeGreaterThan(0);
    expect(of("fixesPerLine", "codeLines")).toMatchObject({ functionSamples: FUNCTIONS * 3, pooledSamples: FUNCTIONS * 3 });
  });

  test("refuses a unit it does not know", async () => {
    expect((await runComplexity(repo.path, ["backtest", "--unit", "class"])).code).toBe(ExitCode.Usage);
  });
});
