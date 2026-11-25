import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { identityHistory } from "./support/identity-scenario.ts";
import { knowledgeHistory } from "./support/knowledge-scenario.ts";
import { steadyHistory } from "./support/scenarios.ts";
import { runCochange } from "./support/run.ts";

vi.setConfig({ testTimeout: 120_000 });

let identity: GitFixture;
let knowledge: GitFixture;
beforeAll(() => {
  identity = identityHistory();
  knowledge = knowledgeHistory();
});
afterAll(() => {
  identity.dispose();
  knowledge.dispose();
});

function configure(repo: GitFixture, settings: Record<string, unknown>): void {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { enabled: true, trials: 100, ...settings } } }));
}
beforeEach(() => {
  for (const repo of [identity, knowledge]) rmSync(join(repo.path, ".code-health"), { recursive: true, force: true });
});

const run = async (repo: GitFixture, ...args: string[]) => {
  const { code, stdout } = await runCochange(repo.path, ["abandonment", ...args]);
  expect(code).toBe(ExitCode.Success);
  return JSON.parse(stdout);
};

const mappedNotice = (notices: string[] | undefined) => (notices ?? []).filter((n) => n.startsWith("Identities that are settled"));

test("current and simulate print the mapped share when it is under the guideline, and still print every result", async () => {
  configure(identity, { turnoverRate: 10 });
  const current = await run(identity, "current", "--by", "component");
  const notice = mappedNotice(current.notices);
  expect(notice).toHaveLength(1);
  expect(notice[0]).toMatch(/hold \d+(\.\d+)?% of the lines held by people, under the guideline of 80%/);
  expect(mappedNotice((await run(identity, "simulate")).notices)).toHaveLength(1);
  expect(current.results.length).toBeGreaterThan(0);
});

test("a mapped share at or above the guideline prints no notice", async () => {
  configure(identity, { turnoverRate: 10, mappedShareGuideline: 0 });
  expect(mappedNotice((await run(identity, "current", "--by", "component")).notices)).toEqual([]);
});

test("a rate from fewer periods than the guideline is labelled a weak estimate, and a configured rate is not", async () => {
  const weak = (document: { notices?: string[] }) => (document.notices ?? []).filter((n) => n.includes("leaver probabilities"));
  configure(knowledge, { minTurnoverPeriods: 7 });
  expect(weak(await run(knowledge, "simulate", "--trials", "50")).filter((n) => n.includes("6 observed 3-month period(s), under the guideline of 7"))).toHaveLength(1);
  configure(knowledge, { minTurnoverPeriods: 6 });
  expect(weak(await run(knowledge, "simulate", "--trials", "50"))).toEqual([]);
  configure(knowledge, { minTurnoverPeriods: 7, turnoverRate: 10 });
  expect(weak(await run(knowledge, "simulate", "--trials", "50"))).toEqual([]);
});

test("a turnover rate below one percent says it is a percentage, and is shown as written", async () => {
  configure(knowledge, { turnoverRate: 0.3 });
  const document = await run(knowledge, "simulate", "--trials", "50");
  expect(document.inputs.turnoverRatePercent).toBe(0.3);
  expect((document.notices as string[]).some((n) => n.includes("is 0.3 percent of developers leaving per 3-month period") && n.includes("30 means 30 percent"))).toBe(true);
});

test("a history too short to estimate turnover says which key to set and in what units", async () => {
  const young = steadyHistory();
  try {
    writeFileSync(join(young.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { enabled: true } } }));
    for (const sub of ["simulate", "trend"]) {
      const refused = await runCochange(young.path, ["abandonment", sub]);
      expect(refused.code).toBe(ExitCode.Usage);
      expect(refused.stderr).toContain("cochange.knowledge.turnoverRate");
      expect(refused.stderr).toContain("percentage of developers who leave in one 3-month period");
      expect(refused.stderr).toContain("0 to 100");
    }
  } finally {
    young.dispose();
  }
});

const upperBound = (notices: string[] | undefined) => (notices ?? []).filter((n) => n.startsWith("The loss figures are an upper bound"));

test("a high leaver probability says the loss figures are an upper bound, at the guideline and not below it", async () => {
  // A rate of 30 percent per period over four periods is a leaver probability of 1 - 0.7^4, 76 percent.
  configure(knowledge, { turnoverRate: 30 });
  const high = upperBound((await run(knowledge, "simulate")).notices);
  expect(high).toHaveLength(1);
  expect(high[0]).toContain("leaves within the horizon is 76%, at or above the guideline of 50% (cochange.knowledge.leaverProbabilityGuideline)");
  expect(upperBound((await run(knowledge, "trend", "--points", "2")).notices)).toHaveLength(1);
  configure(knowledge, { turnoverRate: 30, leaverProbabilityGuideline: 77 });
  expect(upperBound((await run(knowledge, "simulate")).notices)).toEqual([]);
  configure(knowledge, { turnoverRate: 10 });
  expect(upperBound((await run(knowledge, "simulate")).notices)).toEqual([]);
});

test("a mapped share under its guideline also says the loss figures are an upper bound", async () => {
  configure(identity, { turnoverRate: 1 });
  const notice = upperBound((await run(identity, "simulate")).notices);
  expect(notice).toHaveLength(1);
  expect(notice[0]).toContain("(cochange.knowledge.mappedShareGuideline)");
  expect(notice[0]).not.toContain("leaverProbabilityGuideline");
});

test("grouping by component with no components configured says so, and configured components do not", async () => {
  const unconfigured = (notices: string[] | undefined) => (notices ?? []).filter((n) => n.includes("No components are configured"));
  configure(knowledge, { turnoverRate: 10 });
  const current = await run(knowledge, "current", "--by", "component");
  expect(current.results.map((r: { path: string }) => r.path)).toEqual(["(unassigned)"]);
  expect(unconfigured(current.notices)).toHaveLength(1);
  expect(unconfigured((await run(knowledge, "current")).notices)).toEqual([]);
  writeFileSync(join(knowledge.path, "code-health.json"), JSON.stringify({ components: { core: "src/core/**" }, cochange: { knowledge: { enabled: true, trials: 100, turnoverRate: 10 } } }));
  expect(unconfigured((await run(knowledge, "current", "--by", "component")).notices)).toEqual([]);
});

test("adoption says why a rate is null: nothing abandoned at the date, or nothing adopted", async () => {
  configure(knowledge, {});
  const none = await run(knowledge, "adoption", "--at", "2024-06-01", "--horizon", "1");
  expect(none.results).toMatchObject({ abandoned: 2, adopted: 0, recommendationHitRate: null });
  expect(none.notices.join("\n")).toContain("recommendationHitRate is null: none of the 2 files abandoned at 2024-06-01 was adopted");
  const early = await run(knowledge, "adoption", "--at", "2023-06-01", "--horizon", "1");
  expect(early.results).toMatchObject({ abandoned: 0, adoptionRate: null, recommendationHitRate: null });
  expect(early.notices.join("\n")).toContain("adoptionRate and recommendationHitRate are null: no file was abandoned at 2023-06-01");
});
