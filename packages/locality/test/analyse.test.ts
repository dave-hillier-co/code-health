import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { reportPath } from "../src/reports.ts";
import { expectGolden, withoutMeta } from "./support/golden.ts";
import { runLocality } from "./support/run.ts";
import { distantHelpers } from "./support/scenarios.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = distantHelpers();
});
afterAll(() => repo.dispose());
beforeEach(() => {
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
});

interface Row {
  path: string;
  recommendation: string;
  rule: string;
  target: string;
  location: string;
  gain: number;
  fanIn: number;
  unit: { kind: string; files: string[]; tests: string[]; cycle: boolean };
  signals: { name: string; detail: string }[];
  blockers: { path: string; kind: string; unblockedGain: number }[];
  cohesion?: { mixed: boolean; components: { symbols: string[]; target: string; recommendation: string }[] };
  testRefs: { owned: string[]; external: string[] };
}

async function analyse(...args: string[]) {
  const { code, stdout, stderr } = await runLocality(repo.path, ["analyse", "--limit", "all", ...args]);
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  const document = JSON.parse(stdout);
  const rows = document.results as Row[];
  return { stdout, document, rows, row: (path: string) => rows.find((r) => r.path === path) as Row };
}

test("a helper with two consumers moves to their lowest common ancestor", async () => {
  const { row } = await analyse();
  expect(row("src/shared/utils/money.ts")).toMatchObject({
    recommendation: "move",
    rule: "two-consumers",
    location: "src/shared/utils",
    target: "src",
    gain: 4,
    fanIn: 2,
  });
});

test("a tiny helper with one consumer is inlined, and its own test is carried with it", async () => {
  const { row } = await analyse();
  const slug = row("src/shared/utils/slug.ts");
  expect(slug).toMatchObject({ recommendation: "inline", rule: "single-consumer-tiny", target: "src/orders", fanIn: 1 });
  expect(slug.unit.tests).toEqual(["src/shared/utils/slug.test.ts"]);
  expect(slug.testRefs).toEqual({ owned: ["src/shared/utils/slug.test.ts"], external: [] });
});

test("a large helper with one consumer moves next to it as its own module", async () => {
  const { row } = await analyse();
  expect(row("src/shared/utils/invoice.ts")).toMatchObject({
    recommendation: "move",
    rule: "single-consumer-large",
    target: "src/billing",
  });
});

test("a pass-through with one consumer is inlined even beside its consumer", async () => {
  const { row } = await analyse();
  const audit = row("src/orders/audit.ts");
  expect(audit).toMatchObject({ recommendation: "inline", rule: "pass-through", gain: 0 });
  expect(audit.signals).toContainEqual({ name: "pass-through", detail: "audit" });
});

test("a barrel with one importing file is inlined on its own, without the branch behind it", async () => {
  const { row } = await analyse();
  expect(row("src/billing/index.ts")).toMatchObject({ recommendation: "inline", rule: "single-consumer-barrel" });
  expect(row("src/billing/index.ts").unit.files).toEqual(["src/billing/index.ts"]);
});

test("a file whose exports have disjoint consumers in different folders is split", async () => {
  const { row } = await analyse();
  const mixed = row("src/shared/helpers/mixed.ts");
  expect(mixed).toMatchObject({ recommendation: "split", rule: "mixed-exports" });
  expect(mixed.cohesion?.mixed).toBe(true);
  expect(mixed.cohesion?.components.map((c) => [c.symbols, c.target])).toEqual([
    [["invoiceLabel"], "src/billing"],
    [["orderLabel"], "src/orders"],
  ]);
  expect(mixed.signals).toContainEqual({ name: "vague-name", detail: "helpers" });
});

test("a heavily used formatter is scrutinised, not moved, and its flag parameter is a signal", async () => {
  const { row } = await analyse();
  const format = row("src/shared/format.ts");
  expect(format).toMatchObject({ recommendation: "scrutinise", rule: "high-fan-in", fanIn: 8 });
  expect(format.signals).toContainEqual({ name: "special-general-mixture", detail: "fmt(compact)" });
});

test("an import cycle moves as one unit", async () => {
  const { row } = await analyse();
  expect(row("src/shared/cycle/a.ts")).toMatchObject({
    recommendation: "move",
    target: "src/orders",
    unit: { kind: "branch", files: ["src/shared/cycle/a.ts", "src/shared/cycle/b.ts"], cycle: true },
  });
});

test("a unit held in place by its own dependency is blocked, with the gain it would have unblocked", async () => {
  const { row } = await analyse();
  const tool = row("src/lib/kernel/tool.ts");
  expect(tool).toMatchObject({ recommendation: "blocked", rule: "blocked-by-dependency", gain: 0 });
  expect(tool.blockers).toEqual([expect.objectContaining({ path: "src/lib/kernel/core.ts", kind: "stray", unblockedGain: 4 })]);
});

test("sibling files that share internals form a multi-entry unit, named by its folder", async () => {
  const { row, rows } = await analyse();
  expect(row("src/shared/pair")).toMatchObject({
    recommendation: "move",
    rule: "two-consumers",
    target: "src/reports",
    unit: { kind: "sibling-set", entries: ["src/shared/pair/a.ts", "src/shared/pair/b.ts"] },
  });
  expect(row("src/shared/pair").unit.files).toEqual(["src/shared/pair/a.ts", "src/shared/pair/b.ts", "src/shared/pair/core.ts"]);
  // Siblings that share nothing are not a unit of their own: their individual units already cover them.
  expect(rows.filter((r) => r.unit.kind === "sibling-set").map((r) => r.path)).toEqual(["src/shared/pair"]);
});

test("a branch whose files sit outside its entry's folder is reviewed, since its leaves are scored on their own", async () => {
  const { row } = await analyse();
  expect(row("src/orders/place.ts")).toMatchObject({ recommendation: "review", rule: "scattered-unit" });
});

test("unused exports are overexposed, and units already near their consumers are not listed", async () => {
  const { row, rows } = await analyse();
  expect(row("src/shared/utils/money.ts").signals).toContainEqual({ name: "overexposure", detail: "unusedExport" });
  expect(rows.map((r) => r.path)).not.toContain("src/features/feature1.ts");
  expect(rows.some((r) => r.rule === "near-consumers")).toBe(false);
});

test("files the entry point cannot reach are reported, and do not count as consumers", async () => {
  const { document, row } = await analyse();
  expect(document.unreachable).toEqual(["src/legacy/dead.ts"]);
  expect(row("src/shared/utils/money.ts").fanIn).toBe(2);
  expect(document.inputs).toMatchObject({ entrySource: "config", entries: ["src/main.ts"] });
});

test("results are ranked by score, then path", async () => {
  const { rows, document } = await analyse();
  expect(document.results.length).toBe(rows.length);
  const scored = document.results as { score: number; path: string }[];
  for (let i = 1; i < scored.length; i++) {
    const a = scored[i - 1]!;
    const b = scored[i]!;
    expect(a.score > b.score || (a.score === b.score && a.path < b.path)).toBe(true);
  }
});

test("--recommendation and path arguments filter, and filtered runs store no report", async () => {
  const blocked = await analyse("--recommendation", "blocked");
  expect(blocked.rows.every((r) => r.recommendation === "blocked")).toBe(true);
  expect(blocked.rows.map((r) => r.path)).toContain("src/lib/kernel/tool.ts");
  const orders = await analyse("src/shared/utils");
  expect(orders.rows.every((r) => r.path.startsWith("src/shared/utils/"))).toBe(true);
  expect(existsSync(reportPath(repo.path, "analyse"))).toBe(false);
});

test("a whole-repository run on a clean tree stores every result as reports/locality.analyse.json", async () => {
  const { stdout } = await runLocality(repo.path, ["analyse", "--limit", "3"]);
  const stored = readFileSync(reportPath(repo.path, "analyse"), "utf8");
  const printed = JSON.parse(stdout);
  const report = JSON.parse(stored);
  expect(printed.results.length).toBe(3);
  expect(report.results.length).toBe(printed.truncated.total);
  expect(report).toMatchObject({ tool: "locality", command: "analyse", repo: { head: printed.repo.head, dirty: false } });
  expect(report.meta).toBeUndefined();
  expect(stored).toBe(withoutMeta(stored));
});

test("the output is byte for byte reproducible", async () => {
  const first = (await analyse()).stdout;
  const second = (await analyse()).stdout;
  expect(withoutMeta(first)).toBe(withoutMeta(second));
  expectGolden("distant-helpers", "analyse", first);
});

test("explain describes every rule the analyser can name", async () => {
  const { stdout } = await runLocality(repo.path, ["explain"]);
  for (const rule of ["single-consumer-tiny", "two-consumers", "high-fan-in", "mixed-exports", "blocked-by-dependency"]) {
    expect(stdout).toContain(rule);
  }
  const { stdout: one } = await runLocality(repo.path, ["explain", "pass-through"]);
  expect(one).toMatch(/^pass-through: /);
});
