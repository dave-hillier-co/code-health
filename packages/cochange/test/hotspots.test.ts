import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

const hotspots = (...args: string[]) => runCochange(repo.path, ["hotspots", ...args]);
const json = (stdout: string) => JSON.parse(stdout);
const config = (document: unknown) => writeFileSync(join(repo.path, "code-health.json"), JSON.stringify(document));

function writeComplexityReport(head: string, rows: { path: string; complexity: number }[], dirty = false) {
  const dir = join(repo.path, ".cache", "code-health", "reports");
  mkdirSync(dir, { recursive: true });
  const document = { schemaVersion: 1, tool: "complexity", command: "files", repo: { head, dirty }, config: "0".repeat(16), results: rows };
  writeFileSync(join(dir, "complexity.files.json"), JSON.stringify(document));
}

test("files are ranked by change frequency weighted by indentation complexity", async () => {
  const { code, stdout, stderr } = await hotspots();
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  const document = json(stdout);
  expect(document.complexitySource).toBe("indentation");
  expect(document.complexityMeasure).toBe("indentation-complexity");
  expect(document.inputs).toEqual({ by: "file", allFiles: false, includeTests: false, complexityReport: null });
  expect(document.results.map((r: { path: string }) => r.path)).toEqual([
    "src/core/engine.ts",
    "src/legacy/old.ts",
    "src/core/util.ts",
    "src/ui/page.ts",
  ]);
  const [engine, legacy, util, page] = document.results;
  expect(engine).toMatchObject({ frequency: 5, complexity: 36, ageDays: 0, recommendation: "hotspot" });
  expect(legacy).toMatchObject({ frequency: 3, complexity: 9, lastChanged: "2023-10-10T09:00:00.000Z" });
  expect(util).toMatchObject({ frequency: 5, complexity: 0, recommendation: null });
  expect(page).toMatchObject({ frequency: 2, complexity: 4, lastChanged: "2024-05-20T09:00:00.000Z", recommendation: null });
  // Percentiles over four files: frequency 5 is 0.75, complexity 36 is 0.875.
  expect(engine.score).toBeCloseTo(0.75 * 0.875, 6);
  expect(util.score).toBeCloseTo(0.75 * 0.125, 6);
  expectGolden("indented", "hotspots", stdout);
});

test("files with no revision in the window, and files that no longer exist, are not listed", async () => {
  const paths = json((await hotspots()).stdout).results.map((r: { path: string }) => r.path);
  expect(paths).not.toContain("docs/guide.md");
});

test("churn is lines added plus lines deleted in the window", async () => {
  const { results } = json((await hotspots()).stdout);
  const util = results.find((r: { path: string }) => r.path === "src/core/util.ts");
  // five one line edits: one line out and one line in each time
  expect(util.churn).toBe(10);
});

test("a complexity report stamped with the current head replaces the proxy and is named in inputs", async () => {
  const head = repo.git("rev-parse", "HEAD").trim();
  writeComplexityReport(head, [
    { path: "src/core/engine.ts", complexity: 3 },
    { path: "src/core/util.ts", complexity: 90 },
    { path: "src/legacy/old.ts", complexity: 5 },
    { path: "src/ui/page.ts", complexity: 10 },
  ]);
  const document = json((await hotspots()).stdout);
  expect(document.complexitySource).toBe("complexity-report");
  expect(document.complexityMeasure).toBe("indentation-complexity");
  expect(document.inputs.complexityReport).toEqual({ report: "complexity.files", head, config: "0".repeat(16) });
  expect(document.results.map((r: { path: string }) => r.path)).toEqual([
    "src/core/util.ts",
    "src/legacy/old.ts",
    "src/core/engine.ts",
    "src/ui/page.ts",
  ]);
  expect(document.results[0].complexity).toBe(90);
  expectGolden("indented", "hotspots.complexity-report", (await hotspots()).stdout);
});

test("a complexity report from another commit or a dirty tree is ignored", async () => {
  writeComplexityReport("a".repeat(40), [{ path: "src/core/util.ts", complexity: 90 }]);
  expect(json((await hotspots()).stdout).complexitySource).toBe("indentation");
  writeComplexityReport(repo.git("rev-parse", "HEAD").trim(), [{ path: "src/core/util.ts", complexity: 90 }], true);
  expect(json((await hotspots()).stdout).complexitySource).toBe("indentation");
});

test("a file the complexity report does not mention has no complexity and no score", async () => {
  writeComplexityReport(repo.git("rev-parse", "HEAD").trim(), [{ path: "src/core/engine.ts", complexity: 3 }]);
  const { results } = json((await hotspots()).stdout);
  expect(results[0].path).toBe("src/core/engine.ts");
  const page = results.find((r: { path: string }) => r.path === "src/ui/page.ts");
  expect(page).toMatchObject({ complexity: null, score: null, recommendation: null });
});

test("--by component groups files by the configured components", async () => {
  config({ components: { core: ["src/core/**"], legacy: ["src/legacy/**"], ui: ["src/ui/**"] } });
  const { stdout } = await hotspots("--by", "component");
  const document = json(stdout);
  expect(document.inputs.by).toBe("component");
  expect(document.results.map((r: { path: string }) => r.path)).toEqual(["core", "legacy", "ui"]);
  const [core, legacy, ui] = document.results;
  // Five logical changes touched core, each touching both of its files, so it counts five, not ten.
  expect(core).toMatchObject({ files: 2, frequency: 5, complexity: 36, churn: 20 });
  expect(legacy).toMatchObject({ files: 1, frequency: 3, complexity: 9, churn: 6 });
  expect(ui).toMatchObject({ files: 1, frequency: 2, complexity: 4, churn: 4 });
  expectGolden("indented", "hotspots.component", stdout);
});

test("files outside every component are grouped as unassigned", async () => {
  config({ components: { ui: ["src/ui/**"] } });
  const paths = json((await hotspots("--by", "component")).stdout).results.map((r: { path: string }) => r.path);
  expect(paths.sort()).toEqual(["(unassigned)", "ui"]);
});

test("--by component without configured components is a config error", async () => {
  const { code, stderr } = await hotspots("--by", "component");
  expect(code).toBe(ExitCode.Usage);
  expect(stderr).toContain("components");
});

test("--by rejects other values", async () => {
  const { code, stderr } = await hotspots("--by", "folder");
  expect(code).toBe(ExitCode.Usage);
  expect(stderr).toContain("--by");
});

test("--limit cuts the printed list but the stored report keeps every file", async () => {
  const { stdout } = await hotspots("--limit", "1");
  const document = json(stdout);
  expect(document.results).toHaveLength(1);
  expect(document.truncated).toEqual({ limit: 1, total: 4, cut: 3 });
  const stored = JSON.parse((await import("node:fs")).readFileSync(reportPath(repo.path, "hotspots"), "utf8"));
  expect(stored.results).toHaveLength(4);
  // A stored result carries what a table run prints with it, and no wall-clock facts.
  expect(Object.keys(stored.meta)).toEqual(["printed"]);
});

test("a view by component is stored under its own name, never as the plain report other plugins read", async () => {
  config({ components: { core: ["src/core/**"] } });
  await hotspots("--by", "component");
  expect((await import("node:fs")).existsSync(reportPath(repo.path, "hotspots"))).toBe(false);
  expect(JSON.parse((await hotspots("--by", "component")).stdout).inputs.resultsCache).toHaveLength(1);
});

test("a lower percentile flags more files, but only those changed within the recent window", async () => {
  // Share of files scoring strictly higher: engine 0, legacy 0.25, util 0.5. The top 70 percent flags the first two by score.
  config({ cochange: { hotspotPercentile: 70 } });
  const { results } = json((await hotspots()).stdout);
  const flagged = (path: string) => results.find((r: { path: string }) => r.path === path).recommendation;
  expect(flagged("src/core/engine.ts")).toBe("hotspot");
  // legacy scores in the top group but was last changed in October 2023, outside the three month recent window.
  expect(flagged("src/legacy/old.ts")).toBeNull();
  expect(flagged("src/core/util.ts")).toBeNull();
});

test("a longer recent window brings the quiet file back in", async () => {
  config({ cochange: { hotspotPercentile: 70, recentMonths: 9 } });
  const { results } = json((await hotspots()).stdout);
  expect(results.find((r: { path: string }) => r.path === "src/legacy/old.ts").recommendation).toBe("hotspot");
});

test("output is byte identical between runs apart from meta and the note of where the inputs came from", async () => {
  const first = await hotspots("--no-cache");
  const second = await hotspots("--no-cache");
  expect(withoutMeta(second.stdout)).toBe(withoutMeta(first.stdout));
  const cached = await hotspots();
  expect(JSON.parse(cached.stdout).inputs.resultsCache).toHaveLength(1);
  expect(withoutMeta(cached.stdout)).toBe(withoutMeta(first.stdout));
});

test("a repository with no component of any kind still ranks, here on a flat history", async () => {
  const flat = steadyHistory();
  try {
    const { code, stdout } = await runCochange(flat.path, ["hotspots"]);
    expect(code).toBe(ExitCode.Success);
    expect(json(stdout).results[0].path).toBe("src/billing/invoice.ts");
    expectGolden("steady", "hotspots", stdout);
  } finally {
    flat.dispose();
  }
});
