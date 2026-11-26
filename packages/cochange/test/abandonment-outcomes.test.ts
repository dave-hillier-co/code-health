import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { runCochange } from "./support/run.ts";
import { adoptionHistory, a, b, e } from "./support/adoption-scenario.ts";
import { auth, knowledgeHistory, routes } from "./support/knowledge-scenario.ts";

vi.setConfig({ testTimeout: 120_000 });

function configure(repo: GitFixture, knowledge: Record<string, unknown> = {}): void {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { enabled: true, ...knowledge } } }));
}

const run = async (repo: GitFixture, ...args: string[]) => {
  const { code, stdout, stderr } = await runCochange(repo.path, ["abandonment", ...args]);
  return { code, stdout, stderr };
};
const json = async (repo: GitFixture, ...args: string[]) => {
  const { code, stdout, stderr } = await run(repo, ...args);
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  return JSON.parse(stdout);
};

describe("on the knowledge history", () => {
  let repo: GitFixture;
  beforeAll(() => {
    repo = knowledgeHistory();
  });
  afterAll(() => repo.dispose());
  beforeEach(() => {
    rmSync(join(repo.path, ".code-health"), { recursive: true, force: true });
    configure(repo);
  });

  test("redundancy: routes has two active authors holding half each, auth has one, so half the hotspot files are redundant", async () => {
    const document = await json(repo, "redundancy", "--limit", "all");
    expect(document.summary).toEqual({ hotspotFiles: 2, redundant: 1, share: 0.5 });
    const byPath = Object.fromEntries(document.results.map((r: { path: string }) => [r.path, r]));
    expect(byPath[routes]).toMatchObject({ redundant: true, qualifyingAuthors: 2, activeAuthors: 2, peopleLines: 10 });
    expect(byPath[auth]).toMatchObject({ redundant: false, qualifyingAuthors: 1, activeAuthors: 1, peopleLines: 10 });
    // Files without redundancy come first: they are the ones to act on.
    expect(document.results[0].path).toBe(auth);
    expectGolden("abandonment", "abandonment.redundancy", (await run(repo, "redundancy", "--limit", "all")).stdout);
  });

  test("the minimum share and the number of authors are options, and 60 percent leaves routes with none qualifying", async () => {
    const document = await json(repo, "redundancy", "--min-share", "60", "--limit", "all");
    expect(document.summary).toEqual({ hotspotFiles: 2, redundant: 0, share: 0 });
    expect(document.inputs).toMatchObject({ minAuthors: 2, minSharePercent: 60 });
    const single = await json(repo, "redundancy", "--min-authors", "1", "--limit", "all");
    expect(single.summary.redundant).toBe(2);
  });

  test("the output has developers as counts and never a name or an address", async () => {
    const { stdout } = await run(repo, "redundancy");
    for (const hidden of ["example.com", "Ann", "Bob", "Cy", "Eve"]) expect(stdout).not.toContain(hidden);
  });

  test("trend: points go back one period (three average months) at a time at one rate, oldest first", async () => {
    const document = await json(repo, "trend", "--points", "3", "--trials", "200");
    const { results } = document;
    expect(results.points.map((p: { date: string }) => p.date)).toEqual(["2024-08-30", "2024-11-30", "2025-03-01"]);
    expect(results.rateSource).toBe("history");
    expect(document.inputs).toMatchObject({ points: 3, trials: 200, seed: 1, horizonPeriods: 4 });
    // At HEAD the abandoned files are the three of the current view.
    expect(results.points[2].abandonedFiles).toBe(3);
    expect(results.points[2].commit).toMatch(/^[0-9a-f]{40}$/);
    // Cy had not left in the autumn of 2023 but has by 1 September 2024; Di has not yet, so fewer files are abandoned earlier.
    expect(results.points[0].abandonedFiles).toBeLessThanOrEqual(results.points[2].abandonedFiles);
    expect(["rising", "falling", "flat"]).toContain(results.direction);
    expectGolden("abandonment", "abandonment.trend", (await run(repo, "trend", "--points", "3", "--trials", "200")).stdout);
  });

  test("trend reports the measured population of every point, and blaming the past trees keeps the blame of HEAD", async () => {
    rmSync(join(repo.path, ".cache", "code-health", "blame.sqlite"), { force: true });
    const document = await json(repo, "trend", "--points", "3", "--trials", "200");
    // The view is added in September 2024, so the oldest point has seven files and HEAD eight, and every file has a blame.
    expect(document.results.points.map((p: { files: number; unknownFiles: number }) => [p.files, p.unknownFiles])).toEqual([
      [7, 0],
      [8, 0],
      [8, 0],
    ]);
    const current = await json(repo, "current", "--no-refresh");
    expect(current.blame.unknownFiles).toBe(0);
  });

  test("a point whose files have no blame says so, and a sharp change in the population between points is a notice", async () => {
    rmSync(join(repo.path, ".cache", "code-health", "blame.sqlite"), { force: true });
    await json(repo, "current");
    const stale = await json(repo, "trend", "--points", "3", "--trials", "200", "--no-refresh");
    const oldest = stale.results.points[0];
    expect(oldest.unknownFiles).toBeGreaterThan(0);
    expect(stale.notices.join("\n")).toContain(`${oldest.unknownFiles} files with no blame in the cache at ${oldest.date}`);
    // From seven files to eight is 14 percent, over a guideline of 10.
    configure(repo, { populationChangeGuideline: 10 });
    const refreshed = await json(repo, "trend", "--points", "3", "--trials", "200");
    expect(refreshed.notices.join("\n")).toMatch(/measured files went from 7 at 2024-08-30 to 8 at 2024-11-30/);
    expect(refreshed.inputs.populationChangeGuideline).toBe(10);
    configure(repo);
    const quiet = await json(repo, "trend", "--points", "3", "--trials", "200");
    expect((quiet.notices ?? []).join("\n")).not.toContain("measured files went from");
  });

  test("trend with a fixed rate reports it as configured, and is repeatable", async () => {
    configure(repo, { turnoverRate: 10 });
    const first = await json(repo, "trend", "--points", "2", "--trials", "100");
    const second = await json(repo, "trend", "--points", "2", "--trials", "100");
    expect(first.results.rateSource).toBe("configured");
    expect(first.results.ratePerPeriod).toBe(0.1);
    expect(first.results).toEqual(second.results);
  });

  test("trend refuses a model other than the rate model, and options of other subcommands", async () => {
    const mode = await run(repo, "trend", "--mode", "historical");
    expect(mode.code).toBe(ExitCode.Usage);
    const points = await run(repo, "current", "--points", "3");
    expect(points.code).toBe(ExitCode.Usage);
    expect(points.stderr).toContain("--points belongs to abandonment trend");
  });

  test("the instruments refuse when the repository switches the analysis off", async () => {
    writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { enabled: false } } }));
    for (const sub of ["redundancy", "trend", "adoption"]) {
      const { code, stderr } = await run(repo, sub);
      expect(code).toBe(ExitCode.Usage);
      expect(stderr).toContain("cochange.knowledge.enabled");
    }
  });
});

describe("on the adoption history", () => {
  let repo: GitFixture;
  beforeAll(() => {
    repo = adoptionHistory();
  });
  afterAll(() => repo.dispose());
  beforeEach(() => {
    rmSync(join(repo.path, ".code-health"), { recursive: true, force: true });
    configure(repo);
  });

  test("of three abandoned files two are picked up, one by the recommended successor and one by a newcomer, by hand", async () => {
    const document = await json(repo, "adoption", "--at", "2025-02-28", "--horizon", "1");
    const { results } = document;
    expect(results).toMatchObject({
      at: "2025-02-28",
      abandoned: 3,
      changed: 2,
      adopted: 2,
      byRecommended: 1,
      byNewcomer: 1,
      adoptionRate: 0.6667,
      recommendationHitRate: 0.5,
    });
    expect(results.files).toEqual([
      { path: a, changed: true, adopted: true, byRecommended: true, byNewcomer: false },
      { path: b, changed: false, adopted: false, byRecommended: false, byNewcomer: false },
      { path: e, changed: true, adopted: true, byRecommended: false, byNewcomer: true },
    ]);
    expectGolden("abandonment", "abandonment.adoption", (await run(repo, "adoption", "--at", "2025-02-28", "--horizon", "1")).stdout);
  });

  test("the number of recommended successors is an option", async () => {
    const document = await json(repo, "adoption", "--at", "2025-02-28", "--horizon", "1", "--successors", "1");
    expect(document.results.byRecommended).toBe(1);
    expect(document.inputs.successors).toBe(1);
  });

  test("a date too late for a whole horizon is refused", async () => {
    const { code, stderr } = await run(repo, "adoption", "--at", "2025-05-30", "--horizon", "1");
    expect(code).toBe(ExitCode.Usage);
    expect(stderr).toContain("whole horizon");
  });

  test("no developer is named", async () => {
    const { stdout } = await run(repo, "adoption", "--at", "2025-02-28", "--horizon", "1");
    for (const hidden of ["example.com", "Ann", "Cy", "Eve"]) expect(stdout).not.toContain(hidden);
  });
});
