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
  from: string;
  to: string;
  basis: string;
  disagree: boolean;
  structuralViolation: boolean;
  changeViolation: boolean | null;
  volatilityRatio: number | null;
  stability: { from: Side; to: Side };
}
interface Document {
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
  expect(row).toMatchObject({ id: "unstable:folder:src/stable->src/volatile", basis: "change", changeViolation: true, structuralViolation: false, disagree: true });
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
  expect(row).toMatchObject({ basis: "structure", structuralViolation: true, changeViolation: null, disagree: false });
});

test("a dependency onto something only a little more volatile is not flagged", async () => {
  const { document } = await stability();
  expect(document.results.find((r) => r.from === "src/app" && r.to === "src/volatile")).toBeUndefined();
});

test("dependencies decided by change come first, the larger volatility gap first", async () => {
  const { document } = await stability();
  expect(document.results.map((r) => r.id)).toEqual([
    "unstable:folder:src/stable->src/volatile",
    "unstable:folder:src/glue->src/volatile",
    "unstable:folder:src/lib->src/glue",
  ]);
});

test("every module is listed with its stability, the most volatile first", async () => {
  const { document } = await stability();
  expect(document.units[0]!.id).toBe("src/volatile");
  expect(document.unitsTotal).toBe(6);
});

test("golden", async () => {
  expectGolden("stability", "stability", (await stability()).stdout);
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

  test("a dependant that never changed depending on an active module violates", () => {
    expect(judgeDependency(side(0.5, 0), side(0.5, 1), settings).violates).toBe(true);
  });

  test("an inactive depended-on side falls back to structure", () => {
    const verdict = judgeDependency(side(0.2, 5), side(0.9, 5, false), settings);
    expect(verdict).toMatchObject({ basis: "structure", violates: true, changeViolation: null });
  });

  test("an instability gap below the minimum is not a violation", () => {
    expect(judgeDependency(side(0.5, 1, false), side(0.6, 1, false), settings).violates).toBe(false);
  });

  test("a module with no outside dependency has no instability and so no structural verdict", () => {
    expect(judgeDependency(side(null, 1, false), side(0.9, 1, false), settings).violates).toBe(false);
  });
});
