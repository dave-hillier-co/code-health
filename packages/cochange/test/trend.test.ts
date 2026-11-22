import { existsSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { reportPath } from "../src/reports.ts";
import { expectGolden } from "./support/golden.ts";
import { runCochange } from "./support/run.ts";
import { after, before, trendHistory } from "./support/trend-scenarios.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = trendHistory();
});
afterAll(() => repo.dispose());

const trend = (...args: string[]) => runCochange(repo.path, ["trend", ...args, "--json"]);
const resultOf = (stdout: string) => JSON.parse(stdout).results as Record<string, any>;

test("a file's complexity and size are sampled across its history from blobs, oldest first", async () => {
  const { code, stdout, stderr } = await trend(after, "--samples", "4");
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  const result = resultOf(stdout);
  expect(result.path).toBe(after);
  expect(result.revisions).toBe(8);
  // Revisions 1, 3, 6 and 8 of eight, nesting 1, 3, 6 and 8 deep: complexity is the depth squared.
  expect(result.samples.map((s: any) => s.complexity)).toEqual([1, 9, 36, 64]);
  expect(result.samples.map((s: any) => s.lines)).toEqual([13, 17, 23, 27]);
  expect(result.samples.map((s: any) => s.date.slice(0, 7))).toEqual(["2024-01", "2024-03", "2024-06", "2024-08"]);
  expectGolden("trend", "trend", stdout);
});

test("each sample names the path the file had then, so a rename is followed", async () => {
  const result = resultOf((await trend(after, "--samples", "4")).stdout);
  expect(result.samples.map((s: any) => s.path)).toEqual([before, before, after, after]);
});

test("an old path names the same file as the current one", async () => {
  const result = resultOf((await trend(before, "--samples", "4")).stdout);
  expect(result.path).toBe(after);
  expect(result.revisions).toBe(8);
});

test("the first and last revisions are always sampled and every revision when there are fewer than samples", async () => {
  const all = resultOf((await trend(after, "--samples", "50")).stdout);
  expect(all.samples.map((s: any) => s.complexity)).toEqual([1, 4, 9, 16, 25, 36, 49, 64]);
  const two = resultOf((await trend(after, "--samples", "2")).stdout);
  expect(two.samples.map((s: any) => s.complexity)).toEqual([1, 64]);
});

test("the default is ten samples, so a short history shows every revision", async () => {
  expect(resultOf((await trend(after)).stdout).samples).toHaveLength(8);
});

test("the summary says whether the file is getting worse", async () => {
  const { summary } = resultOf((await trend(after)).stdout);
  expect(summary).toEqual({
    direction: "worsening",
    changeRatio: 63,
    guideline: 0.2,
    peak: { complexity: 64, date: expect.any(String), commit: expect.any(String) },
    complexity: { first: 1, last: 64, change: 63 },
    lines: { first: 13, last: 27, change: 14 },
  });
});

test("the summary reports the measured ratio and the peak next to the direction label", async () => {
  const { summary } = resultOf((await trend(after, "--samples", "2")).stdout);
  expect(summary.changeRatio).toBe(63);
  expect(summary.guideline).toBe(0.2);
  expect(summary.peak.complexity).toBe(64);
});

test("a file with one revision has no trend to report", async () => {
  const result = resultOf((await trend("src/core/flat.ts")).stdout);
  expect(result.summary.direction).toBe("insufficient");
  expect(result.samples).toHaveLength(1);
});

test("a binary file has size but no complexity", async () => {
  const [sample] = resultOf((await trend("assets/logo.png")).stdout).samples;
  expect(sample.complexity).toBeNull();
  expect(sample.bytes).toBe(10);
});

test("the complexity source is the indentation proxy, and a single-file run is not stored as a report", async () => {
  expect(JSON.parse((await trend(after)).stdout).complexitySource).toBe("indentation");
  expect(existsSync(reportPath(repo.path, "trend"))).toBe(false);
});

test("a missing path, an unknown path and a bad sample count are usage errors", async () => {
  expect((await trend()).code).toBe(ExitCode.Usage);
  expect((await trend("no/such/file.ts")).code).toBe(ExitCode.Usage);
  expect((await trend(after, "--samples", "1")).code).toBe(ExitCode.Usage);
  expect((await trend(after, "--samples", "many")).code).toBe(ExitCode.Usage);
});
