import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { reportPath } from "../src/reports.ts";
import { identityHistory } from "./support/identity-scenario.ts";
import { auth, knowledgeHistory } from "./support/knowledge-scenario.ts";
import { runCochange, runCochangeOnTerminal } from "./support/run.ts";

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
const identities = /Ann Active|Bob Builder|Cy Gone|Di Departed|Eve Newer|example\.com|dependabot\[bot\]|49699333/;

test("every command that reasons about people refuses until the repository opts in, and leaves nothing behind", async () => {
  configure(null);
  for (const argv of everyCommand) {
    const { code, stdout, stderr } = await runCochange(repo.path, argv);
    expect(code, argv.join(" ")).toBe(ExitCode.Usage);
    expect(stdout).toBe("");
    expect(stderr).toContain("cochange.knowledge.enabled");
  }
  // The gate comes before any history is read or blame is made.
  expect(existsSync(join(repo.path, ".cache", "code-health", "blame.sqlite"))).toBe(false);
});

test("opting in with false is the same as not opting in", async () => {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { enabled: false } } }));
  expect((await runCochange(repo.path, ["abandonment", "simulate"])).code).toBe(ExitCode.Usage);
});

test("no output names or addresses anyone unless successors is asked for names", async () => {
  configure({});
  for (const argv of everyCommand) {
    const { code, stdout, stderr } = await runCochange(repo.path, argv);
    expect(code, argv.join(" ")).toBe(ExitCode.Success);
    expect(stdout, argv.join(" ")).not.toMatch(identities);
    expect(stderr).toBe("");
  }
  // A terminal gets the table, which is as free of names as the JSON.
  const table = await runCochangeOnTerminal(repo.path, ["abandonment", "current", "--limit", "all"]);
  expect(table.stdout).not.toMatch(identities);
  const named = await runCochange(repo.path, ["successors", auth, "--names"]);
  expect(named.stdout).toMatch(/Ann Active/);
});

test("successors --names prints the names of active developers without their addresses", async () => {
  configure({});
  const named = JSON.parse((await runCochange(repo.path, ["successors", auth, "--names"])).stdout);
  expect(named.results[0].successors.map((s: { developer: string }) => s.developer)).toEqual(["Ann Active", "Bob Builder"]);
  expect(JSON.stringify(named.results)).not.toMatch(/example\.com|@/);
});

test("identities check gives counts and shares for former contributors, and names them only with --names", async () => {
  // With a one-month activity window, everyone who stopped committing before the last four weeks of the history has left.
  const people = identityHistory();
  try {
    writeFileSync(join(people.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { activityWindowMonths: 1 } } }));
    const former = /J Park|jo@x\.com|jsmith|John Smith|Maria Lopez|maria@corp\.com|Alex Kim|alex@a\.com|akim@b\.com|Sam Ro|sam@home\.net|sam@corp\.com/i;
    const plain = await runCochange(people.path, ["identities", "check", "--limit", "all"]);
    expect(plain.stdout).not.toMatch(former);
    const named = await runCochange(people.path, ["identities", "check", "--limit", "all", "--names"]);
    expect(named.stdout).toMatch(/J Park/);
    const [withheld, shown] = [JSON.parse(plain.stdout), JSON.parse(named.stdout)];
    expect(withheld.inputs.names).toBe(false);
    expect(plain.code).toBe(named.code);
    // The same findings with the same counts: only the identities and the words naming them differ.
    const counts = (d: { results: { kind: string; lines: number | null; commits: number | null; linesShare: number | null }[] }) =>
      d.results.map((r) => [r.kind, r.lines, r.commits, r.linesShare]);
    expect(counts(withheld)).toEqual(counts(shown));
    expect(withheld.results.some((r: { formerContributors: number }) => r.formerContributors > 0)).toBe(true);
    // A last-active date is given only for an identity still shown, never for a former contributor withheld.
    for (const r of withheld.results as { identities: string[]; detail: string }[]) if (r.detail.includes("last active")) expect(r.identities).not.toEqual([]);
    // An active identity is still named, because settling it is what the check is for.
    expect(plain.stdout).toContain("Jo Park <jo+git@x.com>");
    expect(withheld.measurement).toEqual(shown.measurement);
  } finally {
    people.dispose();
  }
});

test("only the configured simulation is stored as a report, and it holds files and counts and no one's name", async () => {
  configure({});
  for (const argv of everyCommand) await runCochange(repo.path, argv);
  for (const command of ["abandonment", "abandonment.current", "successors", "blame"]) expect(existsSync(reportPath(repo.path, command)), command).toBe(false);
  const reports = join(repo.path, ".cache", "code-health", "reports");
  const stored = existsSync(reports) ? readdirSync(reports) : [];
  expect(stored.filter((file) => /abandon|successor|blame|knowledge/.test(file))).toEqual(["cochange.abandonment.simulate.json"]);
  expect(readFileSync(join(reports, "cochange.abandonment.simulate.json"), "utf8")).not.toMatch(identities);
});

test("a stated rate and the seed are all that decide the numbers, so nothing about a person can", async () => {
  configure({ turnoverRate: 25 });
  const run = async () => JSON.stringify({ ...JSON.parse((await runCochange(repo.path, ["abandonment", "simulate", "--seed", "5"])).stdout), meta: undefined });
  const first = await run();
  expect(await run()).toBe(first);
  expect(first).not.toMatch(identities);
});
