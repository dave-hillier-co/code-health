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

const mappedNotice = (notices: string[] | undefined) => (notices ?? []).filter((n) => n.includes("mappedShareGuideline"));

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
