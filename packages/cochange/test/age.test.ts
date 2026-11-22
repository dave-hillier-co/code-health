import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { reportPath } from "../src/reports.ts";
import { expectGolden, withoutMeta } from "./support/golden.ts";
import { runCochange } from "./support/run.ts";
import { indentedHistory, steadyHistory } from "./support/scenarios.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = indentedHistory();
});
afterAll(() => repo.dispose());
beforeEach(() => {
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
  rmSync(join(repo.path, "code-health.json"), { force: true });
  repo.git("checkout", "--quiet", "--", ".");
});

const age = (...args: string[]) => runCochange(repo.path, ["age", ...args]);
const ageAll = (...args: string[]) => age("--all-files", ...args);
const json = (stdout: string) => JSON.parse(stdout);
const config = (document: unknown) => writeFileSync(join(repo.path, "code-health.json"), JSON.stringify(document));
type Row = { path: string };

test("files are listed oldest last change first, with first-seen and last-changed over all history", async () => {
  const { code, stdout, stderr } = await ageAll();
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  const document = json(stdout);
  expect(document.results.map((r: Row) => r.path)).toEqual([
    "docs/guide.md",
    "src/legacy/old.ts",
    "src/ui/page.ts",
    "src/core/engine.ts",
    "src/core/util.ts",
  ]);
  const [guide, legacy, page, engine] = document.results;
  // guide.md is outside the 12 month analysis window but still listed: age reads the whole history.
  expect(guide).toMatchObject({
    firstSeen: "2023-01-05T09:00:00.000Z",
    lastChanged: "2023-01-05T09:00:00.000Z",
    revisions: 1,
    ageDays: 527,
    score: 527,
    recommendation: "cold",
  });
  expect(legacy).toMatchObject({ revisions: 4, firstSeen: "2023-01-05T09:00:00.000Z", lastChanged: "2023-10-10T09:00:00.000Z" });
  expect(page).toMatchObject({ revisions: 3, ageDays: 26, recommendation: null });
  expect(engine).toMatchObject({ revisions: 6, ageDays: 0, recommendation: null });
  expect(document.window.since).toBe("2023-01-05T09:00:00.000Z");
  expect(document.window.until).toBe("2024-06-15T09:00:00.000Z");
  expectGolden("indented", "age", stdout);
});

test("cold is measured against the stale window back from the head commit", async () => {
  // Stale after 6 months: before 2023-12-15, so legacy (October 2023) joins guide.md.
  config({ cochange: { staleMonths: 6 } });
  const cold = json((await ageAll()).stdout)
    .results.filter((r: { recommendation: string | null }) => r.recommendation === "cold")
    .map((r: Row) => r.path);
  expect(cold).toEqual(["docs/guide.md", "src/legacy/old.ts"]);
});

test("--by component takes the latest and earliest dates across a component's files", async () => {
  config({ components: { core: ["src/core/**"], legacy: ["src/legacy/**"], ui: ["src/ui/**"] } });
  const { stdout } = await ageAll("--by", "component");
  const document = json(stdout);
  expect(document.results.map((r: Row) => r.path)).toEqual(["(unassigned)", "legacy", "ui", "core"]);
  expect(document.results[3]).toMatchObject({ files: 2, revisions: 6, firstSeen: "2023-01-05T09:00:00.000Z" });
  expect(document.results[0]).toMatchObject({ files: 1, recommendation: "cold" });
  expectGolden("indented", "age.component", stdout);
});

test("a file that was moved keeps its first-seen date from before the move", async () => {
  const moved = steadyHistory();
  try {
    const { stdout } = await runCochange(moved.path, ["age"]);
    const summary = json(stdout).results.find((r: Row) => r.path === "src/reporting/summary.ts");
    expect(summary).toMatchObject({ firstSeen: "2024-01-10T09:00:00.000Z", lastChanged: "2024-05-01T09:00:00.000Z", revisions: 3 });
    expectGolden("steady", "age", stdout);
  } finally {
    moved.dispose();
  }
});

test("a repository with only a window stated in config still shows the whole history", async () => {
  config({ cochange: { windowMonths: 2 } });
  const paths = json((await ageAll()).stdout).results.map((r: Row) => r.path);
  expect(paths).toContain("docs/guide.md");
});

test("the report is stored in full on a clean tree, but a component view is not stored", async () => {
  await age("--limit", "1");
  expect(json(readFileSync(reportPath(repo.path, "age"), "utf8")).results).toHaveLength(4);
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
  config({ components: { core: ["src/core/**"] } });
  await age("--by", "component");
  expect(existsSync(reportPath(repo.path, "age"))).toBe(false);
});

test("--by rejects other values and output is byte identical between runs", async () => {
  expect((await age("--by", "folder")).code).toBe(ExitCode.Usage);
  const first = await age();
  expect(withoutMeta((await age()).stdout)).toBe(withoutMeta(first.stdout));
});

test("explain describes both recommendation rules", async () => {
  for (const rule of ["hotspot", "cold"]) {
    const { code, stdout } = await runCochange(repo.path, ["explain", rule]);
    expect(code).toBe(ExitCode.Success);
    expect(stdout).toContain(rule);
  }
});

test("without --all-files the documents are left out and counted, and with it they are listed", async () => {
  const code = json((await age()).stdout);
  expect(code.results.map((r: Row) => r.path)).not.toContain("docs/guide.md");
  expect(code.dropped.nonCode).toBeGreaterThanOrEqual(1);
  expect(json((await ageAll()).stdout).results.map((r: Row) => r.path)).toContain("docs/guide.md");
});
