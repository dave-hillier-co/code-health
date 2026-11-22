import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { partialSpearman, ranks, spearman } from "../src/premise.ts";
import { expectGolden, withoutMeta } from "./support/golden.ts";
import { relocationApp, Sessions } from "./support/measure-scenarios.ts";
import { sessionsWhereDistanceCosts, sessionsWhereDistanceDoesNotCost, sessionsWhereDistanceNeverVaries } from "./support/premise-scenarios.ts";
import { runLocality } from "./support/run.ts";

const disposables: Array<{ dispose(): void }> = [];
afterAll(() => disposables.forEach((item) => item.dispose()));

async function premise(repo: GitFixture, sessions: Sessions, args: string[] = []) {
  const run = await runLocality(repo.path, ["measure", "premise", ...args, "--projects-dir", sessions.directory, "--json"]);
  return { run, document: run.code === ExitCode.Success ? JSON.parse(run.stdout) : null };
}

function fresh() {
  const repo = relocationApp();
  const sessions = new Sessions(repo.path);
  disposables.push(repo, sessions);
  return { repo, sessions };
}

describe("rank statistics", () => {
  test("ties share the mean of their positions", () => {
    expect(ranks([10, 20, 20, 5])).toEqual([2, 3.5, 3.5, 1]);
  });

  test("a monotone relationship is a correlation of 1 and its reverse -1", () => {
    expect(spearman([1, 2, 3, 4], [10, 40, 90, 100])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
  });

  test("a side that does not vary has no correlation", () => {
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
  });

  test("holding a variable constant removes what it alone explains", () => {
    // y follows size (z) exactly, and x follows it too, so x adds nothing once size is held.
    const z = [1, 2, 3, 4, 5, 6];
    const x = [1, 3, 2, 5, 4, 6];
    const y = z;
    expect(spearman(x, y)).toBeGreaterThan(0.8);
    expect(Math.abs(partialSpearman(x, y, z) as number)).toBeLessThan(1e-9);
  });
});

describe("measure premise", () => {
  test("finds that distant tasks cost more, with the sample, the evidence and the limits stated", async () => {
    const { repo, sessions } = fresh();
    sessionsWhereDistanceCosts(sessions);
    const run = await premise(repo, sessions);
    expect(run.run.stderr).toBe("");
    expect(run.run.code).toBe(ExitCode.Success);
    const { results } = run.document;
    expect(results.window).toEqual({ from: "2023-01-01", to: "2024-01-02" });
    expect(results.tasks).toEqual({ inWindow: 16, measured: 16, singleFile: 0 });
    expect(results.figures.filesRead).toMatchObject({ n: 16, conclusion: "costlier-when-distant" });
    expect(results.figures.tokens.far.mean).toBeGreaterThan(results.figures.tokens.near.mean);
    expect(results.verdict).toBe("supported");
    expect(results.history.spread).toMatchObject({ changes: 28, measured: 28 });
    expect(run.document.evidence.grade).toMatch(/strong|moderate|weak/);
    expect(results.limits.join(" ")).toMatch(/not a measure of what a move would save/);
    expect(run.document.inputs.transcripts.tasks).toBe(16);
    expectGolden("measure", "measure.premise", run.run.stdout);
  }, 60_000);

  test("claims nothing when cost does not follow distance", async () => {
    const { repo, sessions } = fresh();
    sessionsWhereDistanceDoesNotCost(sessions);
    const { document } = await premise(repo, sessions);
    expect(document.results.verdict).toBe("not-shown");
    expect(document.results.meaning).toMatch(/not evidence there is none/);
  }, 60_000);

  test("says distance could not be tested, not that no relationship was shown, when it never varies", async () => {
    const { repo, sessions } = fresh();
    sessionsWhereDistanceNeverVaries(sessions);
    const { document } = await premise(repo, sessions);
    expect(document.results.figures.filesRead.conclusion).toBe("not-measured");
    expect(document.results.verdict).toBe("not-measured");
    expect(document.results.meaning).toMatch(/distance did not vary/);
  }, 60_000);

  test("concludes nothing from fewer tasks than locality.measureMinSamples", async () => {
    const { repo, sessions } = fresh();
    sessionsWhereDistanceCosts(sessions);
    const config = JSON.parse(readFileSync(join(repo.path, "code-health.json"), "utf8"));
    writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ ...config, locality: { measureMinSamples: 100 } }));
    const { document } = await premise(repo, sessions);
    expect(document.results.verdict).toBe("insufficient-sample");
    expect(document.results.figures.filesRead.conclusion).toBe("insufficient-sample");
  }, 60_000);

  test("with no transcripts it reports no tasks and no verdict", async () => {
    const { repo, sessions } = fresh();
    const { document } = await premise(repo, sessions);
    expect(document.results.tasks).toEqual({ inWindow: 0, measured: 0, singleFile: 0 });
    expect(document.results.verdict).toBe("insufficient-sample");
    expect(document.results.figures.tokens).toMatchObject({ spearman: null, near: { tasks: 0, mean: null } });
  }, 60_000);

  test("takes a window with --since and --until, and rejects one that is not a date or is backwards", async () => {
    const { repo, sessions } = fresh();
    sessionsWhereDistanceCosts(sessions);
    const outside = await premise(repo, sessions, ["--since", "2023-06-01", "--until", "2023-12-01"]);
    expect(outside.document.results.window).toEqual({ from: "2023-06-01", to: "2023-12-01" });
    expect(outside.document.results.tasks.inWindow).toBe(0);
    expect((await premise(repo, sessions, ["--since", "June"])).run.code).toBe(ExitCode.Usage);
    expect((await premise(repo, sessions, ["--since", "2023-06-01", "--until", "2023-05-01"])).run.code).toBe(ExitCode.Usage);
  }, 60_000);

  test("is byte for byte reproducible", async () => {
    const { repo, sessions } = fresh();
    sessionsWhereDistanceCosts(sessions);
    const first = await premise(repo, sessions);
    const second = await premise(repo, sessions);
    expect(withoutMeta(second.run.stdout)).toBe(withoutMeta(first.run.stdout));
  }, 60_000);
});
