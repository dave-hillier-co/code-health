import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { hiddenCouplingApp, ratesRepo, type RatesRepo } from "./support/co-change-scenarios.ts";
import { runLocality } from "./support/run.ts";

const repos: GitFixture[] = [];
afterAll(() => repos.forEach((repo) => repo.dispose()));

interface Row {
  path: string;
  source: string;
  recommendation: string;
  rule: string;
  location: string;
  target: string;
  gain: number;
  fanIn: number;
  unit: { kind: string; files: string[] };
  consumers: { path: string; support: number; confidence: number; weight: number }[];
}

async function historyOnly(options: RatesRepo, config: Record<string, unknown> = {}, extra: string[] = []) {
  const repo = ratesRepo(options);
  repos.push(repo);
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ locality: config }));
  const run = await runLocality(repo.path, ["analyse", "--source", "history", "--json", "--limit", "all", ...extra]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  const document = JSON.parse(run.stdout);
  return { run, document, rows: document.results as Row[] };
}

describe("history-only analysis, with no import graph", () => {
  test("a file far from the files that always change with it moves to them", async () => {
    const { rows, run } = await historyOnly({ rounds: 60, every: 3 });
    const rates = rows.find((row) => row.path === "lib/config/rates.yaml")!;
    expect(rates).toMatchObject({
      source: "history",
      recommendation: "move",
      rule: "history-partners",
      location: "lib/config",
      target: "billing",
      fanIn: 2,
    });
    expect(rates.consumers.map((partner) => partner.path)).toEqual(["billing/invoice.txt", "billing/tax.txt"]);
    expectGolden("history-only", "analyse.history", run.stdout);
  });

  test("the partners are not themselves moved towards the rates file, because the pull is balanced", async () => {
    const { rows, document } = await historyOnly({ rounds: 60, every: 3 });
    expect(rows.map((row) => row.path)).toEqual(["lib/config/rates.yaml"]);
    // The dropped direction is named on the kept candidate, with its gain, so the omission has a stated reason.
    const dropped = (rows[0] as unknown as { supersedes: { path: string; gain: number }[] }).supersedes;
    expect(dropped.map((entry) => entry.path)).toEqual(["billing/invoice.txt"]);
    expect(document.historyOnly.omitted.superseded).toBe(dropped.length);
  });

  test("the gain is reported beside the minDistance guideline", async () => {
    const { rows } = await historyOnly({ rounds: 60, every: 3 });
    const { gain } = (rows[0] as unknown as { guidelines: { gain: { value: number; guideline: number; ratio: number } } }).guidelines;
    expect(gain).toEqual({ value: rows[0]!.gain, guideline: 2, ratio: rows[0]!.gain / 2 });
  });

  test("every candidate is a move or a review, never an inline or a split", async () => {
    const { rows } = await historyOnly({ rounds: 60, every: 3 });
    expect(rows.every((row) => row.recommendation === "move" || row.recommendation === "review")).toBe(true);
  });

  test("on weak evidence it reports nothing, and says why", async () => {
    const { rows, document } = await historyOnly({ rounds: 12, every: 3 });
    expect(rows).toEqual([]);
    expect(document.historyOnly.reason).toMatch(/weak/);
    expect(document.history.grade).toBe("weak");
  });

  test("a file added within the grace period is reviewed, not moved", async () => {
    const { rows } = await historyOnly({ rounds: 100, every: 2, ratesAdded: "2023-09-20T09:00:00Z" });
    // The rates file is then 40 days old at HEAD, and the billing files are old.
    expect(rows.find((row) => row.path === "lib/config/rates.yaml")).toMatchObject({ recommendation: "review", rule: "history-within-grace-period" });
  });

  test("a partner needs the configured support before it counts", async () => {
    const { rows } = await historyOnly({ rounds: 60, every: 3 }, { historyMinSupport: 21 });
    expect(rows).toEqual([]);
  });

  test("a fixed point is left where it is", async () => {
    const { rows, document } = await historyOnly({ rounds: 60, every: 3 }, { fixedPoints: ["lib/config/**"] });
    expect(rows.map((row) => row.path)).not.toContain("lib/config/rates.yaml");
    // The billing files may still move towards it, but never into its folder.
    expect(rows.map((row) => row.target)).not.toContain("lib/config");
    expect(document.historyOnly.omitted["fixed-point"]).toBe(1);
  });

  test("the rules it names are described by explain", async () => {
    const repo = ratesRepo({ rounds: 12, every: 3 });
    repos.push(repo);
    const run = await runLocality(repo.path, ["explain", "history-partners"]);
    expect(run.code).toBe(ExitCode.Success);
    expect(run.stdout).toContain("change in the same logical changes");
  });
});

describe("where the import graph and the history disagree", () => {
  test("files the graph places well but that always change together with a file elsewhere have hidden coupling", async () => {
    const repo = hiddenCouplingApp();
    repos.push(repo);
    const run = await runLocality(repo.path, ["analyse", "--source", "both", "--json", "--limit", "all"]);
    expect(run.stderr).toBe("");
    const document = JSON.parse(run.stdout);
    expect(document.inputs.source).toBe("both");
    expect(document.hiddenCoupling).toHaveLength(1);
    const [hidden] = document.hiddenCoupling as Row[];
    expect([hidden!.path, ...hidden!.consumers.map((partner) => partner.path)].sort()).toEqual(["src/feature/report.ts", "src/other/export.ts"]);
    expect(hidden).toMatchObject({ source: "history", recommendation: "move" });
    // The structural results are unchanged by the cross-check.
    expect((document.results as Row[]).every((row) => row.source === "structural")).toBe(true);
  });
});
