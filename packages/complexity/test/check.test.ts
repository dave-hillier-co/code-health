import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { Change, GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { runComplexity } from "./support/run.ts";
import { oneMoreBranch, priceFunction, repoWithFeature, riskyFunction, simpleFunction } from "./support/ratchet.ts";

const repos: GitFixture[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.dispose();
});

function repoWith(changes: Change[], configuration?: string): GitFixture {
  const repo = repoWithFeature(changes, configuration);
  repos.push(repo);
  return repo;
}

interface Finding {
  id: string;
  finding: "new" | "worsened";
  metric: string;
  before: number | null;
  after: number;
  guideline: number;
  delta: number | null;
  renamedFrom: string | null;
}

async function check(repo: GitFixture, ...args: string[]) {
  const run = await runComplexity(repo.path, ["check", "--json", "--limit", "all", ...args]);
  const document = run.stdout === "" ? undefined : JSON.parse(run.stdout);
  return { ...run, document, findings: (document?.results ?? []) as Finding[] };
}

describe("a function that existed at the base", () => {
  test("fails when it is over a threshold and got worse, naming each metric that rose", async () => {
    const repo = repoWith([{ op: "modify", path: "src/pricing.ts", content: priceFunction("price", oneMoreBranch) }]);
    const run = await check(repo);
    expect(run.code).toBe(ExitCode.CheckFailed);
    expectGolden("ratchet-worsened", "check", run.stdout);
    expect(run.findings.map((f) => [f.id, f.finding, f.metric, f.before, f.after, f.guideline, f.delta])).toEqual([
      ["src/pricing.ts#price", "worsened", "cognitive", 8, 9, 6, 1],
      ["src/pricing.ts#price", "worsened", "cyclomatic", 5, 6, 4, 1],
    ]);
  });

  test("passes when it is over a threshold and did not get worse, or got better", async () => {
    const same = repoWith([{ op: "modify", path: "src/pricing.ts", content: `// reformatted\n${priceFunction()}` }]);
    expect((await check(same)).code).toBe(ExitCode.Success);

    const better = repoWith([
      {
        op: "modify",
        path: "src/pricing.ts",
        content: "export function price(order: { items: number[]; vip: boolean }): number {\n  return order.items.length;\n}\n",
      },
    ]);
    const run = await check(better);
    expect(run.code).toBe(ExitCode.Success);
    expect(run.findings).toEqual([]);
  });

  test("passes a function that stays under its thresholds however much it changed", async () => {
    const repo = repoWith([{ op: "modify", path: "src/label.ts", content: "export const label = (n: string): string => (n ? n.trim() : n);\n" }]);
    expect((await check(repo)).code).toBe(ExitCode.Success);
  });

  test("allows a worsening up to the configured delta", async () => {
    const relaxed = JSON.stringify({
      complexity: { delta: 1, thresholds: { cognitive: { warn: 6, high: 12 }, cyclomatic: { warn: 4, high: 8 } } },
    });
    const repo = repoWith([{ op: "modify", path: "src/pricing.ts", content: priceFunction("price", oneMoreBranch) }], relaxed);
    expect((await check(repo)).code).toBe(ExitCode.Success);
  });

  test("does not look at functions in files the change left alone", async () => {
    const repo = repoWith([{ op: "add", path: "src/simple.ts", content: simpleFunction }]);
    const run = await check(repo);
    expect(run.code).toBe(ExitCode.Success);
    expect(run.document.summary.compared).toBe(1);
    expectGolden("ratchet-pass", "check", run.stdout);
  });
});

describe("a function that is new", () => {
  test("fails when it is over a threshold, and passes when it is not", async () => {
    const repo = repoWith([
      { op: "add", path: "src/risky.ts", content: riskyFunction },
      { op: "add", path: "src/simple.ts", content: simpleFunction },
    ]);
    const run = await check(repo);
    expect(run.code).toBe(ExitCode.CheckFailed);
    expectGolden("ratchet-new", "check", run.stdout);
    expect(run.findings.map((f) => [f.id, f.finding, f.metric, f.before, f.after, f.guideline])).toEqual([
      ["src/risky.ts#risky", "new", "cognitive", null, 10, 6],
      ["src/risky.ts#risky", "new", "cyclomatic", null, 5, 4],
    ]);
  });
});

describe("a function that moved or was renamed", () => {
  test("is compared with its old self, so moving it unchanged passes", async () => {
    const repo = repoWith([
      { op: "modify", path: "src/pricing.ts", content: "export const unrelated = 1;\n" },
      { op: "add", path: "src/billing.ts", content: priceFunction() },
    ]);
    const run = await check(repo);
    expect(run.code).toBe(ExitCode.Success);
    expect(run.document.summary).toMatchObject({ moved: 1, removed: 0 });
    expectGolden("ratchet-moved", "check", run.stdout);
  });

  test("is still caught when it worsened on the way", async () => {
    const repo = repoWith([
      { op: "modify", path: "src/pricing.ts", content: "export const unrelated = 1;\n" },
      { op: "add", path: "src/billing.ts", content: priceFunction("computePrice", oneMoreBranch) },
    ]);
    const run = await check(repo);
    expect(run.code).toBe(ExitCode.CheckFailed);
    expect(run.findings.map((f) => [f.id, f.finding, f.metric, f.renamedFrom])).toEqual([
      ["src/billing.ts#computePrice", "worsened", "cognitive", "src/pricing.ts#price"],
      ["src/billing.ts#computePrice", "worsened", "cyclomatic", "src/pricing.ts#price"],
    ]);
    expectGolden("ratchet-moved-worsened", "check", run.stdout);
  });

  test("counts as new when it was rewritten beyond recognition", async () => {
    const rewritten = `export function quote(order: { items: number[]; vip: boolean; coupon?: string }): number {
  switch (order.items.length) {
    case 0:
      return 0;
    case 1:
      return order.vip ? 1 : 2;
    case 2:
      return order.coupon ? 3 : 4;
    default:
      return order.items.reduce((sum, item) => sum + (item > 100 ? 1 : 0), 0);
  }
}
`;
    const repo = repoWith([{ op: "modify", path: "src/pricing.ts", content: rewritten }]);
    const run = await check(repo);
    expect(run.code).toBe(ExitCode.CheckFailed);
    expect(run.findings.map((f) => [f.id, f.finding, f.metric, f.renamedFrom])).toEqual([
      ["src/pricing.ts#quote", "new", "cyclomatic", null],
      ["src/pricing.ts#quote", "new", "cognitive", null],
    ]);
    expect(run.document.summary).toMatchObject({ added: 1, removed: 1, moved: 0 });
  });
});

describe("the base", () => {
  test("defaults to the merge base with main, so commits on main made since the branch point are not seen", async () => {
    const repo = repoWith([{ op: "add", path: "src/simple.ts", content: simpleFunction }]);
    repo.git("checkout", "--quiet", "main");
    repo.commit({
      message: "A newer commit on main",
      date: "2024-01-03T00:00:00+00:00",
      changes: [{ op: "add", path: "src/risky.ts", content: riskyFunction }],
    });
    repo.git("checkout", "--quiet", "feature");
    const run = await check(repo);
    expect(run.code).toBe(ExitCode.Success);
    expect(run.document.inputs.base.rev).toBe("merge base of HEAD and main");
  });

  test("is given by --base, and an unknown revision is a usage error", async () => {
    const repo = repoWith([{ op: "modify", path: "src/pricing.ts", content: priceFunction("price", oneMoreBranch) }]);
    const sameCommit = await check(repo, "--base", "HEAD");
    expect(sameCommit.code).toBe(ExitCode.Success);
    expect(sameCommit.document.summary.compared).toBe(0);
    expectGolden("ratchet-base", "check", sameCommit.stdout);
    expect((await check(repo, "--base", "HEAD~1")).code).toBe(ExitCode.CheckFailed);
    const unknown = await check(repo, "--base", "nope");
    expect(unknown.code).toBe(ExitCode.Usage);
    expect(unknown.stderr).toMatch(/unknown revision .*nope/);
  });

  test("is complexity.base when the config names one", async () => {
    const configured = JSON.stringify({
      complexity: { base: "HEAD", thresholds: { cognitive: { warn: 6, high: 12 }, cyclomatic: { warn: 4, high: 8 } } },
    });
    const repo = repoWith([{ op: "modify", path: "src/pricing.ts", content: priceFunction("price", oneMoreBranch) }], configured);
    expect((await check(repo)).code).toBe(ExitCode.Success);
  });

  test("needs --base when there is no main branch", async () => {
    const repo = repoWith([{ op: "add", path: "src/simple.ts", content: simpleFunction }]);
    repo.git("branch", "--quiet", "-m", "main", "trunk");
    const run = await check(repo);
    expect(run.code).toBe(ExitCode.Usage);
    expect(run.stderr).toContain("pass --base REV");
  });
});

describe("uncommitted work", () => {
  test("is checked against the base as it stands on disk, as a pre-commit run wants", async () => {
    const repo = repoWith([{ op: "add", path: "src/simple.ts", content: simpleFunction }]);
    expect((await check(repo)).code).toBe(ExitCode.Success);
    writeFileSync(join(repo.path, "src/risky.ts"), riskyFunction);
    const run = await check(repo);
    expect(run.code).toBe(ExitCode.CheckFailed);
    expect(run.document.inputs.against).toBe("working-tree");
    expect(run.document.summary).toMatchObject({ added: 2 });
    expect(run.findings.map((f) => f.id)).toEqual(["src/risky.ts#risky", "src/risky.ts#risky"]);
    expectGolden("ratchet-dirty", "check", run.stdout);
  });
});

test("the config can raise thresholds for some paths", async () => {
  const lenient = JSON.stringify({
    complexity: {
      thresholds: { cognitive: { warn: 6, high: 12 }, cyclomatic: { warn: 4, high: 8 } },
      overrides: [{ paths: ["src/generated/**"], thresholds: { cognitive: { warn: 50, high: 60 }, cyclomatic: { warn: 50, high: 60 } } }],
    },
  });
  const repo = repoWith(
    [
      { op: "add", path: "src/generated/risky.ts", content: riskyFunction },
      { op: "add", path: "src/risky.ts", content: riskyFunction },
    ],
    lenient,
  );
  const run = await check(repo);
  expect(run.code).toBe(ExitCode.CheckFailed);
  expect([...new Set(run.findings.map((f) => f.id))]).toEqual(["src/risky.ts#risky"]);
  expectGolden("ratchet-override", "check", run.stdout);
});

test("without config the thresholds are the defaults (cognitive 15, cyclomatic 10), which risky is under", async () => {
  const repo = repoWith([{ op: "add", path: "src/risky.ts", content: riskyFunction }], "{}");
  expect((await check(repo)).code).toBe(ExitCode.Success);
});

test.each([
  ["high below warn", { cognitive: { warn: 40, high: 3 } }],
  ["only warn raised above the configured high", { cognitive: { warn: 40 } }],
])("an override with %s is a config error, as the global thresholds are", async (_name, thresholds) => {
  const repo = repoWith([{ op: "add", path: "src/risky.ts", content: riskyFunction }], JSON.stringify({ complexity: { overrides: [{ paths: ["src/**"], thresholds }] } }));
  const run = await check(repo);
  expect(run.code).toBe(ExitCode.Usage);
  expect(run.stderr).toContain("high must not be below warn");
});
