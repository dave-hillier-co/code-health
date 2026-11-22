import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { runCochange } from "./support/run.ts";
import { auth, deps, engine, knowledgeHistory, lexer, log, parser } from "./support/knowledge-scenario.ts";

vi.setConfig({ testTimeout: 120_000 });

let repo: GitFixture;
beforeAll(() => {
  repo = knowledgeHistory();
});
afterAll(() => repo.dispose());

function configure(knowledge: Record<string, unknown> = {}, more: Record<string, unknown> = {}): void {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ ...more, cochange: { knowledge: { enabled: true, ...knowledge } } }));
}
beforeEach(() => {
  rmSync(join(repo.path, ".code-health"), { recursive: true, force: true });
  rmSync(join(repo.path, ".mailmap"), { force: true });
  configure();
});

const abandonment = (...args: string[]) => runCochange(repo.path, ["abandonment", ...args]);
const json = async (...args: string[]) => {
  const { code, stdout, stderr } = await abandonment(...args);
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  return JSON.parse(stdout);
};
const paths = (document: { results: { path: string }[] }) => document.results.map((r) => r.path);

test("the analysis is off until the repository opts in, and says how", async () => {
  writeFileSync(join(repo.path, "code-health.json"), "{}");
  const { code, stderr, stdout } = await abandonment("current");
  expect(code).toBe(ExitCode.Usage);
  expect(stdout).toBe("");
  expect(stderr).toContain("cochange.knowledge.enabled");
});

test("files whose people have left are abandoned: engine, parser at exactly 90 percent, and what people wrote in the bot's file", async () => {
  const document = await json("current", "--limit", "all");
  expect(paths(document)).toEqual([engine, parser, deps]);
  expect(document.results[0]).toMatchObject({ abandonedShare: 1, abandonedLines: 10, peopleLines: 10, activeAuthors: 0, formerAuthors: 1 });
  expect(document.results[1]).toMatchObject({ abandonedShare: 0.9, abandonedLines: 9, peopleLines: 10, activeAuthors: 1, formerAuthors: 1 });
  // Bot lines are on neither side of the share, and are reported apart.
  expect(document.results[2]).toMatchObject({ abandonedShare: 1, abandonedLines: 5, peopleLines: 5, nonPersonLines: 5, formerAuthors: 1 });
  expect(document.summary).toEqual({
    files: { measured: 8, abandoned: 3, share: 0.375 },
    lines: { people: 75, abandoned: 32, share: 0.4267, nonPerson: 5, unattributed: 0 },
  });
  expect(document.developers).toEqual({ active: 3, inactive: 2 });
  expect(document.blame).toEqual({ unknownFiles: 0, unattributedLines: 0 });
});

test("the output has developers as counts and never a name or an address", async () => {
  const { stdout } = await abandonment("current", "--limit", "all");
  for (const hidden of ["example.com", "Ann", "Bob", "Cy", "Di ", "Eve", "dependabot[bot]"]) expect(stdout).not.toContain(hidden);
  expectGolden("abandonment", "abandonment.current", stdout);
});

test("the threshold is configurable and decides on exact arithmetic", async () => {
  configure({ abandonmentThreshold: 91 });
  expect(paths(await json("current", "--limit", "all"))).toEqual([engine, deps]);
  configure({ abandonmentThreshold: 80 });
  expect(paths(await json("current", "--limit", "all"))).toEqual([engine, lexer, parser, deps]);
});

test("components group files, lines and the abandoned share", async () => {
  configure({}, { components: { core: "src/core/**", api: "src/api/**" } });
  const document = await json("current", "--by", "component", "--limit", "all");
  expect(document.results).toEqual([
    expect.objectContaining({ path: "core", files: 3, abandonedFiles: 2, peopleLines: 30, abandonedLines: 27, abandonedShare: 0.9 }),
    expect.objectContaining({ path: "(unassigned)", files: 3, abandonedFiles: 1, peopleLines: 25, abandonedLines: 5, abandonedShare: 0.2 }),
  ]);
});

test("an activity override corrects who counts as active, and stays local", async () => {
  const dir = join(repo.path, ".code-health", "local");
  mkdirSync(dir, { recursive: true });
  // Cy is on leave, not gone, and Bob has in fact left.
  writeFileSync(
    join(dir, "knowledge-overrides.json"),
    JSON.stringify({ schemaVersion: 1, active: ["Cy Gone <cy@example.com>"], inactive: ["Bob Builder <bob@example.com>"] }),
  );
  const document = await json("current", "--limit", "all");
  // Cy's lines are no longer abandoned. Bob's now are: the lexer is all Di and Bob, and the log is all Bob.
  expect(paths(document)).toEqual([lexer, deps, log]);
  expect(document.inputs.overrides).toMatchObject({ active: 1, inactive: 1 });
  expect(document.inputs.overrides.hash).toMatch(/^[0-9a-f]{16}$/);
  expect(document.developers).toEqual({ active: 3, inactive: 2 });
});

function annHasLeft(): void {
  const dir = join(repo.path, ".code-health", "local");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "knowledge-overrides.json"), JSON.stringify({ schemaVersion: 1, inactive: ["Ann Active <ann@example.com>"] }));
}

test("abandoned files are ranked by the hotspot percentile weighting the abandoned share, so code that changes comes first", async () => {
  annHasLeft();
  const document = await json("current", "--limit", "all");
  // Auth is all Ann's and changes every ten days; the others are cold. Cold files tie at 0 and keep path order.
  expect(paths(document)).toEqual([auth, engine, parser, deps]);
  expect(document.results[0]).toMatchObject({ hotspot: true, hotspotPercentile: 0.6667, score: 0.6667, findings: ["abandoned"] });
  expect(document.results[1]).toMatchObject({ hotspot: false, hotspotPercentile: 0, score: 0 });
});

test("--rank abandonment is the raw view: by the lines lost, whatever changes", async () => {
  annHasLeft();
  const document = await json("current", "--rank", "abandonment", "--limit", "all");
  expect(document.inputs.rank).toBe("abandonment");
  // Auth, engine and parser each lose 10 lines and tie, in path order; the bot file loses 5.
  expect(paths(document)).toEqual([auth, engine, parser, deps]);
  expect(document.results.map((r: { score: number }) => r.score)).toEqual([10, 10, 10, 5]);
  configure({ rank: "abandonment" });
  expect((await json("current")).inputs.rank).toBe("abandonment");
});

test("the ranking mode must be a known one, and belongs to current and simulate", async () => {
  expect((await abandonment("current", "--rank", "people")).code).toBe(ExitCode.Usage);
  expect((await abandonment("turnover", "--rank", "hotspot")).code).toBe(ExitCode.Usage);
});

test("every finding is explained, with the mitigation it suggests", async () => {
  for (const rule of ["abandoned", "at-risk-hot", "at-risk-cold", "concentrated-component", "no-successor"]) {
    const { code, stdout } = await runCochange(repo.path, ["explain", rule]);
    expect(code).toBe(ExitCode.Success);
    expect(stdout).toMatch(/^[a-z-]+: /);
    expect(stdout).toMatch(/Suggested mitigation/);
  }
});

test("without a refresh, files the cache holds nothing for are unknown, not abandoned", async () => {
  rmSync(join(repo.path, ".cache", "code-health", "blame.sqlite"), { force: true });
  const { code } = await runCochange(repo.path, ["refresh"]);
  expect(code).toBe(ExitCode.Success);
  const document = await json("current", "--no-refresh");
  expect(document.results).toEqual([]);
  expect(document.blame.unknownFiles).toBe(8);
});

test("a mailmap change is applied without a new blame", async () => {
  await json("current");
  // Cy's work and Ann's are one person after the mapping, and she is active.
  writeFileSync(join(repo.path, ".mailmap"), "Ann Active <ann@example.com> Cy Gone <cy@example.com>\n");
  const document = await json("current", "--no-refresh", "--limit", "all");
  expect(paths(document)).toEqual([deps]);
  expect(document.blame.unknownFiles).toBe(0);
});
