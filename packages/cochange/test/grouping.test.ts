import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture, type Step } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { model, splitFeatures, view } from "./support/grouping-scenarios.ts";
import { runCochange } from "./support/run.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = splitFeatures();
});
afterAll(() => repo.dispose());
afterEach(() => rmSync(join(repo.path, "code-health.json"), { force: true }));

const config = (cochange: Record<string, unknown>) => writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange }));
const run = async (...argv: string[]) => {
  const result = await runCochange(repo.path, [...argv, "--json", "--limit", "all"]);
  return { ...result, document: result.stdout === "" ? null : JSON.parse(result.stdout) };
};

test("with grouping off a feature split over three commits shows no coupling", async () => {
  const { document } = await run("coupling");
  expect(document.results).toEqual([]);
  expect(document.population).toEqual({ eligibleChanges: 24, oversizedExcluded: 0 });
  expect(document.filtersApplied.grouping).toEqual({ mode: "off", issuePattern: null, windowSeconds: null, mergedCommits: 0 });
});

test("grouping by issue key counts a split feature once, so its files are coupled", async () => {
  config({ grouping: "issue-key" });
  const { document, stdout } = await run("coupling");
  expect(document.population).toEqual({ eligibleChanges: 12, oversizedExcluded: 0 });
  expect(document.results).toHaveLength(1);
  expect(document.results[0]).toMatchObject({ path: model, with: view, support: 6, degree: 100, confidence: 100, reverseConfidence: 100, distance: 3 });
  expect(document.filtersApplied.grouping).toEqual({
    mode: "issue-key",
    issuePattern: "[A-Z][A-Z0-9]+-\\d+",
    windowSeconds: 90 * 86400,
    mergedCommits: 12,
  });
  expectGolden("grouping", "coupling.issue-key", stdout);
});

test("grouping by author and time window gives the same changes here, as Bob's commits do not break Alice's burst", async () => {
  config({ grouping: "author-window", groupingWindowHours: 3 });
  const { document, stdout } = await run("coupling");
  expect(document.results[0]).toMatchObject({ support: 6, degree: 100 });
  expect(document.filtersApplied.grouping.windowSeconds).toBe(3 * 3600);
  expectGolden("grouping", "coupling.author-window", stdout);
});

test("a window shorter than the gap between commits leaves them apart", async () => {
  config({ grouping: "author-window", groupingWindowHours: 1 });
  // Alice commits are an hour, then two hours apart: the third falls outside a one hour window.
  const { document } = await run("coupling", "--min-support", "1");
  expect(document.population.eligibleChanges).toBe(18);
});

test("a revision counts a whole grouped change once, so frequency follows logical changes", async () => {
  const off = (await run("hotspots")).document.results.find((r: any) => r.path === model);
  config({ grouping: "issue-key" });
  const on = (await run("hotspots")).document.results.find((r: any) => r.path === model);
  expect([off.frequency, on.frequency]).toEqual([12, 6]);
  // Churn is the same either way: grouping merges changes, it does not drop lines.
  expect(on.churn).toBe(off.churn);
});

test("spread measures the whole grouped change", async () => {
  config({ grouping: "issue-key" });
  const { document } = await run("spread");
  expect(document.results.overall).toMatchObject({ logicalChanges: 12, measured: 12, singleFile: 6, median: 1.5, max: 3 });
});

test("an invalid issue pattern is a config error", async () => {
  config({ grouping: "issue-key", issuePattern: "(" });
  expect((await run("coupling")).code).toBe(ExitCode.Usage);
});

describe("keys that are not issues, and keys reused over years", () => {
  const commit = (message: string, date: string, path: string): Step => ({
    type: "commit",
    message,
    date,
    changes: [{ op: "add", path, content: `export const file = "${path}";\n` }],
  });
  const grouped = async (steps: Step[]) => {
    const fixture = GitFixture.build(steps);
    try {
      writeFileSync(join(fixture.path, "code-health.json"), JSON.stringify({ cochange: { grouping: "issue-key" } }));
      const result = await runCochange(fixture.path, ["spread", "--json"]);
      return JSON.parse(result.stdout).filtersApplied.grouping as { mergedCommits: number; windowSeconds: number };
    } finally {
      fixture.dispose();
    }
  };

  test("encodings and hashes named in a message, such as UTF-8 or SHA-256, are not issue keys", async () => {
    const grouping = await grouped([
      commit("Handle UTF-8 in f1", "2021-01-01T09:00:00Z", "f1.ts"),
      commit("Handle UTF-8 in f2", "2022-01-01T09:00:00Z", "f2.ts"),
      commit("Switch to SHA-256 in f3", "2023-01-01T09:00:00Z", "f3.ts"),
      commit("Switch to SHA-256 in f4", "2024-01-01T09:00:00Z", "f4.ts"),
    ]);
    expect(grouping.mergedCommits).toBe(0);
  });

  test("commits sharing a key join one change only while each follows the last within the key's window", async () => {
    const near = await grouped([commit("ABC-1 first part", "2024-01-01T09:00:00Z", "a.ts"), commit("ABC-1 second part", "2024-01-20T09:00:00Z", "b.ts")]);
    expect(near.mergedCommits).toBe(1);
    expect(near.windowSeconds).toBe(90 * 86400);
    const far = await grouped([commit("ABC-1 first part", "2022-01-01T09:00:00Z", "a.ts"), commit("ABC-1 reused", "2024-01-20T09:00:00Z", "b.ts")]);
    expect(far.mergedCommits).toBe(0);
  });
});
