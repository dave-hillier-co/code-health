import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInProcess, withoutMeta } from "@code-health/fixtures/cli-testing";
import { cli } from "../src/cli.ts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { judgeDependency, type Stability } from "../src/stability.ts";
import { expectGolden } from "./support/golden.ts";
import { runStructure } from "./support/run.ts";
import { stabilityRepository } from "./support/scenarios.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = stabilityRepository();
});
afterAll(() => repo.dispose());

interface Side {
  structural: { ca: number; ce: number; instability: number | null };
  change: { revisions: number; files: number; revisionsPerFile: number; active: boolean };
}
interface Row {
  id: string;
  aboveGuideline: boolean;
  towardsLessStable: boolean;
  from: string;
  to: string;
  basis: string;
  disagree: boolean;
  structuralAboveGuideline: boolean;
  changeAboveGuideline: boolean | null;
  volatilityRatio: number | null;
  stability: { from: Side; to: Side };
}
interface Document {
  inputs: { minTargetFiles: number };
  belowTargetFloor: number;
  results: Row[];
  units: ({ id: string } & Side)[];
  unitsTotal: number;
}

async function stability(...args: string[]) {
  const run = await runStructure(repo.path, ["stability", "--json", ...args]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  return { stdout: run.stdout, document: JSON.parse(run.stdout) as Document };
}

test("a stable folder depending on a volatile one is flagged on change evidence, even when structure says it is fine", async () => {
  const { document } = await stability();
  const row = document.results.find((r) => r.from === "src/stable" && r.to === "src/volatile")!;
  expect(row).toMatchObject({ id: "unstable:folder:src/stable->src/volatile", basis: "change", changeAboveGuideline: true, structuralAboveGuideline: false, disagree: true });
  expect(row.stability.to.change).toMatchObject({ revisions: 6, files: 2, revisionsPerFile: 3, active: true });
  expect(row.stability.from.change).toMatchObject({ revisions: 1, files: 2, revisionsPerFile: 0.5, active: false });
  expect(row.volatilityRatio).toBe(6);
});

test("Martin's instability counts the distinct outside files on each side", async () => {
  const { document } = await stability();
  const volatile = document.units.find((u) => u.id === "src/volatile")!;
  expect(volatile.structural).toEqual({ ca: 3, ce: 0, instability: 0 });
  const lib = document.units.find((u) => u.id === "src/lib")!;
  expect(lib.structural).toEqual({ ca: 3, ce: 1, instability: 0.25 });
});

test("with no change evidence on the depended-on side, structure decides", async () => {
  const { document } = await stability();
  const row = document.results.find((r) => r.from === "src/lib" && r.to === "src/glue")!;
  expect(row).toMatchObject({ basis: "structure", structuralAboveGuideline: true, changeAboveGuideline: null, disagree: false });
});

test("a dependency onto something only a little more volatile is listed below the rows past the guideline", async () => {
  const { document } = await stability();
  const index = document.results.findIndex((r) => r.from === "src/app" && r.to === "src/volatile");
  expect(index).toBeGreaterThan(-1);
  expect(document.results[index]).toMatchObject({ aboveGuideline: false, towardsLessStable: true });
  const lastAbove = document.results.map((r) => r.aboveGuideline && r.stability.to.change.files >= 2).lastIndexOf(true);
  expect(index).toBeGreaterThan(lastAbove);
});

test("rows past the guideline come first, then those decided by change, the larger volatility gap first", async () => {
  const { document } = await stability();
  const atFloor = document.results.filter((r) => r.stability.to.change.files >= 2);
  expect(atFloor.map((r) => r.id)).toEqual(["unstable:folder:src/stable->src/volatile", "unstable:folder:src/glue->src/volatile", "unstable:folder:src/app->src/volatile"]);
});

test("a dependency onto a folder of fewer than structure.minTargetFiles files is listed after the others and counted, as the report leaves it out", async () => {
  const { document } = await stability();
  expect(document.results.map((r) => r.id)).toEqual([
    "unstable:folder:src/stable->src/volatile",
    "unstable:folder:src/glue->src/volatile",
    "unstable:folder:src/app->src/volatile",
    "unstable:folder:src/lib->src/glue",
  ]);
  expect(document.inputs.minTargetFiles).toBe(2);
  expect(document.belowTargetFloor).toBe(1);
  const text = await runInProcess(cli, repo.path, ["stability", "--no-refresh"], true);
  expect(text.stdout).toContain(
    "Notice: 1 dependency onto a folder of fewer than 2 files is listed after the others, because the figures of a one-file folder are the figures of one file (evidence floor structure.minTargetFiles, a judgement call). The structure report leaves it out.",
  );
});

test("every module is listed with its stability, the most volatile first", async () => {
  const { document } = await stability();
  expect(document.units[0]!.id).toBe("src/volatile");
  expect(document.unitsTotal).toBe(6);
});

test("golden", async () => {
  expectGolden("stability", "stability", (await stability()).stdout);
});

test("output is byte identical between runs", async () => {
  expect(withoutMeta((await stability()).stdout)).toBe(withoutMeta((await stability()).stdout));
});

test("--by component ranks configured components, and matches its golden", async () => {
  const config = join(repo.path, "code-health.json");
  writeFileSync(config, JSON.stringify({ components: { steady: ["src/stable/**"], moving: ["src/volatile/**"] } }));
  try {
    const first = (await stability("--by", "component")).stdout;
    expect(withoutMeta((await stability("--by", "component")).stdout)).toBe(withoutMeta(first));
    expect((JSON.parse(first) as Document).units.map((unit) => unit.id).sort()).toEqual(["moving", "steady"]);
    expectGolden("stability", "stability.component", first);
  } finally {
    rmSync(config);
  }
});

test("--by component needs components configured", async () => {
  const run = await runStructure(repo.path, ["stability", "--by", "component"]);
  expect(run.code).toBe(ExitCode.Usage);
});

test("--by with another value is a usage error", async () => {
  const run = await runStructure(repo.path, ["stability", "--by", "galaxy"]);
  expect(run.code).toBe(ExitCode.Usage);
});

describe("judging one dependency", () => {
  const settings = { minVolatilityRatio: 2, minInstabilityGap: 20 };
  const side = (instability: number | null, revisionsPerFile: number, active = true): Stability => ({
    structural: { ca: 1, ce: 1, instability },
    change: { revisions: revisionsPerFile, files: 1, revisionsPerFile, churn: 0, active },
  });

  test("a dependant that never changed depending on an active module aboveGuideline", () => {
    expect(judgeDependency(side(0.5, 0), side(0.5, 1), settings).aboveGuideline).toBe(true);
  });

  test("an inactive depended-on side falls back to structure", () => {
    const verdict = judgeDependency(side(0.2, 5), side(0.9, 5, false), settings);
    expect(verdict).toMatchObject({ basis: "structure", aboveGuideline: true, changeAboveGuideline: null });
  });

  test("an instability gap below the guideline is listed but not above it", () => {
    expect(judgeDependency(side(0.5, 1, false), side(0.6, 1, false), settings).aboveGuideline).toBe(false);
  });

  test("a dependency onto a more stable side is not listed at all", () => {
    expect(judgeDependency(side(0.6, 1, false), side(0.5, 1, false), settings).towardsLessStable).toBe(false);
  });

  test("a module with no outside dependency has no instability and so no structural verdict", () => {
    expect(judgeDependency(side(null, 1, false), side(0.9, 1, false), settings).aboveGuideline).toBe(false);
  });
});
