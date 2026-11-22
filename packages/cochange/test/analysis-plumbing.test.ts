import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { reportPath } from "../src/reports.ts";
import { expectGolden, withoutMeta, withoutMetaOnly } from "./support/golden.ts";
import { probeCli } from "./support/probe-cli.ts";
import { runCochange } from "./support/run.ts";
import { steadyHistory } from "./support/scenarios.ts";

const probe = (cwd: string, ...args: string[]) => runCochange(cwd, ["probe", ...args], probeCli);

let repo: GitFixture;
beforeAll(() => {
  repo = steadyHistory();
});
afterAll(() => repo.dispose());
beforeEach(() => {
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
  rmSync(join(repo.path, "code-health.json"), { force: true });
  repo.git("checkout", "--quiet", "--", ".");
});

test("an analysis command refreshes the cache itself and adds window, filters and evidence", async () => {
  const { code, stdout, stderr } = await probe(repo.path);
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  const document = JSON.parse(stdout);
  expect(document.window).toEqual({ since: "2023-06-01T09:00:00.000Z", until: "2024-06-01T09:00:00.000Z" });
  expect(document.filtersApplied.maxChangesetSize).toBe(30);
  expect(document.evidence).toMatchObject({ grade: "weak", logicalChangesInWindow: 6, activeContributors: 2 });
  expect(document.evidence.window.months).toBe(12);
  expectGolden("_plumbing", "probe", stdout);
});

test("output is byte identical between runs apart from meta", async () => {
  const first = await probe(repo.path);
  const second = await probe(repo.path);
  expect(withoutMeta(second.stdout)).toBe(withoutMeta(first.stdout));
});

test("the window is anchored to the head commit, not the wall clock", async () => {
  writeFileSync(join(repo.path, "code-health.json"), '{"cochange":{"windowMonths":2}}\n');
  const { stdout } = await probe(repo.path);
  const document = JSON.parse(stdout);
  expect(document.window.since).toBe("2024-04-01T09:00:00.000Z");
  // Commits before the window are filtered out of the results but not out of the evidence.
  expect(document.results.map((r: { path: string }) => r.path)).toEqual([
    "README.md",
    "src/billing/invoice.ts",
    "src/reporting/summary.ts",
  ]);
  expect(document.filtersApplied.dropped.outsideWindow).toBe(3);
  expect(document.evidence.logicalChangesInWindow).toBe(3);
  expect(document.evidence.usableHistoryMonths).toBeGreaterThan(4);
});

test("--no-refresh reads the cache as it is, and a missing cache is an environment error", async () => {
  const missing = await probe(repo.path, "--no-refresh", "--json");
  expect(missing.code).toBe(ExitCode.Environment);
  expect(JSON.parse(missing.stderr).error.code).toBe("no-cache");

  await runCochange(repo.path, ["refresh"]);
  const present = await probe(repo.path, "--no-refresh");
  expect(present.code).toBe(ExitCode.Success);
});

test("a clean whole-repository run stores the complete result as a stamped report", async () => {
  const { stdout } = await probe(repo.path, "--limit", "1", "--fields", "path");
  expect(JSON.parse(stdout).results).toHaveLength(1);

  const stored = readFileSync(reportPath(repo.path, "probe"), "utf8");
  const report = JSON.parse(stored);
  expect(report.repo).toEqual({ head: repo.git("rev-parse", "HEAD"), dirty: false });
  expect(report.config).toBe(JSON.parse(stdout).config);
  expect(report.meta).toBeUndefined();
  expect(report.results.map((r: { path: string }) => r.path)).toEqual([
    "src/billing/invoice.ts",
    "src/reports/summary.ts",
    "test/billing/invoice.test.ts",
    "README.md",
    "src/reporting/summary.ts",
  ]);
  expect(report.truncated).toEqual({ limit: null, total: 5, cut: 0 });
  expect(report.evidence.grade).toBe("weak");
  expect(readFileSync(join(repo.path, ".cache/code-health/.gitignore"), "utf8")).toBe("*\n");
  // The stored report is the full, unprojected result in the printed format.
  expect(stored).toBe(withoutMetaOnly((await probe(repo.path, "--limit", "all")).stdout));
});

test("no report is written on a dirty tree", async () => {
  writeFileSync(join(repo.path, "README.md"), "# Edited\n");
  const { code, stdout } = await probe(repo.path);
  expect(code).toBe(ExitCode.Success);
  expect(JSON.parse(stdout).repo.dirty).toBe(true);
  expect(existsSync(reportPath(repo.path, "probe"))).toBe(false);
});

test("untracked files do not make the tree dirty", async () => {
  writeFileSync(join(repo.path, "scratch.txt"), "x\n");
  try {
    await probe(repo.path);
    expect(existsSync(reportPath(repo.path, "probe"))).toBe(true);
  } finally {
    rmSync(join(repo.path, "scratch.txt"));
  }
});

test("no report is written for a partial run or one with a stated window", async () => {
  expect((await probe(repo.path, "--file", "README.md")).code).toBe(ExitCode.Success);
  expect(existsSync(reportPath(repo.path, "probe"))).toBe(false);

  const windowed = await probe(repo.path, "--since", "2024-03-01");
  expect(JSON.parse(windowed.stdout).window.since).toBe("2024-03-01T00:00:00.000Z");
  expect(existsSync(reportPath(repo.path, "probe"))).toBe(false);
});

test("a new commit gives a new stamp", async () => {
  await probe(repo.path);
  const before = JSON.parse(readFileSync(reportPath(repo.path, "probe"), "utf8")).repo.head;
  repo.commit({
    message: "More",
    date: "2024-06-03T09:00:00Z",
    changes: [{ op: "modify", path: "README.md", content: "# More\n" }],
  });
  try {
    await probe(repo.path);
    const after = JSON.parse(readFileSync(reportPath(repo.path, "probe"), "utf8")).repo.head;
    expect(after).toBe(repo.git("rev-parse", "HEAD"));
    expect(after).not.toBe(before);
  } finally {
    repo.git("reset", "--quiet", "--hard", before);
  }
});

test("a shallow clone needs a stated window", async () => {
  const parent = mkdtempSync(join(tmpdir(), "cochange-shallow-"));
  const clone = join(parent, "clone");
  try {
    execFileSync("git", ["clone", "--quiet", "--depth", "2", `file://${repo.path}`, clone], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    const refused = await probe(clone, "--json");
    expect(refused.code).toBe(ExitCode.Environment);
    expect(JSON.parse(refused.stderr).error.code).toBe("shallow-clone");

    const stated = await probe(clone, "--since", "2024-01-01");
    expect(stated.code).toBe(ExitCode.Success);
    expect(JSON.parse(stated.stdout).evidence.truncated).toMatchObject({ shallow: true, boundaryCommits: 1 });

    writeFileSync(join(clone, "code-health.json"), '{"cochange":{"windowMonths":6}}\n');
    expect((await probe(clone)).code).toBe(ExitCode.Success);

    // refresh itself is allowed on a shallow clone and reports the truncation.
    const refreshed = await runCochange(clone, ["refresh"]);
    expect(JSON.parse(refreshed.stdout).results.shallow).toEqual({ isShallow: true, boundaryCommits: 1 });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("history errors map to exit codes through the CLI", async () => {
  writeFileSync(join(repo.path, "code-health.json"), '{"cochange":{"identities":{"botPatterns":["[bot"]}}}\n');
  const { code, stderr } = await probe(repo.path, "--json");
  expect(code).toBe(ExitCode.Usage);
  expect(JSON.parse(stderr).error.code).toBe("config");
});
