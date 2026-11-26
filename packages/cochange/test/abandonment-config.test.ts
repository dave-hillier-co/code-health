import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { reportPath } from "../src/reports.ts";
import { identityHistory } from "./support/identity-scenario.ts";
import { auth, knowledgeHistory } from "./support/knowledge-scenario.ts";
import { runCochange } from "./support/run.ts";

vi.setConfig({ testTimeout: 300_000 });

let repo: GitFixture;
beforeAll(() => {
  repo = knowledgeHistory();
});
afterAll(() => repo.dispose());

function configure(knowledge: Record<string, unknown> | null): void {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify(knowledge === null ? {} : { cochange: { knowledge: { enabled: true, trials: 200, turnoverRate: 10, ...knowledge } } }));
}
beforeEach(() => {
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
  rmSync(join(repo.path, ".code-health"), { recursive: true, force: true });
});

const everyCommand = [
  ["abandonment", "current"],
  ["abandonment", "current", "--by", "component"],
  ["abandonment", "patterns"],
  ["abandonment", "redundancy"],
  ["abandonment", "turnover"],
  ["abandonment", "simulate"],
  ["abandonment", "trend", "--points", "2"],
  ["abandonment", "adoption", "--at", "2024-06-01", "--horizon", "1"],
  ["abandonment", "backtest", "--at", "2024-02-29"],
  ["successors", auth],
];

test("every abandonment command refuses when the repository switches the analysis off, and leaves nothing behind", async () => {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { enabled: false } } }));
  for (const argv of everyCommand) {
    const { code, stdout, stderr } = await runCochange(repo.path, argv);
    expect(code, argv.join(" ")).toBe(ExitCode.Usage);
    expect(stdout).toBe("");
    expect(stderr).toContain("cochange.knowledge.enabled");
  }
  // The check comes before any history is read or blame is made.
  expect(existsSync(join(repo.path, ".cache", "code-health", "blame.sqlite"))).toBe(false);
});

test("the analysis runs with no configuration", async () => {
  configure(null);
  const { code, stderr } = await runCochange(repo.path, ["abandonment", "current"]);
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
});

test("successors prints the names of active developers without their addresses", async () => {
  configure({});
  const named = JSON.parse((await runCochange(repo.path, ["successors", auth])).stdout);
  expect(named.results[0].successors.map((s: { developer: string }) => s.developer)).toEqual(["Ann Active", "Bob Builder"]);
  expect(JSON.stringify(named.results)).not.toMatch(/example\.com|@/);
});

test("identities check names former contributors and counts them", async () => {
  // With a one-month activity window, everyone who stopped committing before the last four weeks of the history has left.
  const people = identityHistory();
  try {
    writeFileSync(join(people.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { activityWindowMonths: 1 } } }));
    const { stdout } = await runCochange(people.path, ["identities", "check", "--limit", "all"]);
    const document = JSON.parse(stdout);
    expect(stdout).toMatch(/J Park/);
    expect(stdout).toContain("Jo Park <jo+git@x.com>");
    expect(document.inputs).not.toHaveProperty("names");
    expect(document.results.some((r: { formerContributors: number }) => r.formerContributors > 0)).toBe(true);
  } finally {
    people.dispose();
  }
});

test("only the configured simulation is stored as a report", async () => {
  configure({});
  for (const argv of everyCommand) await runCochange(repo.path, argv);
  for (const command of ["abandonment", "abandonment.current", "successors", "blame"]) expect(existsSync(reportPath(repo.path, command)), command).toBe(false);
  const reports = join(repo.path, ".cache", "code-health", "reports");
  const stored = existsSync(reports) ? readdirSync(reports) : [];
  expect(stored.filter((file) => /abandon|successor|blame|knowledge/.test(file))).toEqual(["cochange.abandonment.simulate.json"]);
});

test("a stated rate and the seed decide the numbers", async () => {
  configure({ turnoverRate: 25 });
  const run = async () => JSON.stringify({ ...JSON.parse((await runCochange(repo.path, ["abandonment", "simulate", "--seed", "5"])).stdout), meta: undefined });
  const first = await run();
  expect(await run()).toBe(first);
});
