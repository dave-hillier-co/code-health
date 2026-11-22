import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { packages, packagesRun, withPackageSettings } from "./support/run.ts";
import { workspaceRepository } from "./support/workspace.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = workspaceRepository();
});
afterAll(() => repo.dispose());

interface Finding {
  id: string;
  kind: string;
  principle: string;
  packages: string[];
  unit: string | null;
  evidence: Record<string, number | string | boolean | null | string[]>;
  changeCost: number;
  tentative: boolean;
}

async function findings(...args: string[]): Promise<Finding[]> {
  return (await packages(repo, "cohesion", ...args)).document.results as Finding[];
}

const byKind = (all: Finding[], kind: string) => all.filter((f) => f.kind === kind);

describe("always-together", () => {
  test("two packages that change together, and each mostly with the other, are one unit of change", async () => {
    const found = byKind(await findings(), "always-together");
    const ui = found.find((f) => f.packages.join() === "packages/api,packages/ui")!;
    expect(ui.principle).toBe("CCP");
    // 12 shared changes of 15 each
    expect(ui.evidence).toMatchObject({ shared: 12, fromChanges: 15, toChanges: 15, confidenceFromTo: 0.8, confidenceToFrom: 0.8 });
    expect(ui.evidence.lift as number).toBeCloseTo(5.173, 3);
    expect(ui.evidence.tail).toBe(0);
  });

  test("a package that changes in most commits is not always together with anything, whatever its confidence", async () => {
    const pairs = byKind(await findings(), "always-together").map((f) => f.packages.join());
    expect(pairs).not.toContain("packages/app,packages/shared");
  });

  test("the cost is the changes that crossed the boundary, weighted by recency", async () => {
    const found = byKind(await findings(), "always-together");
    const p1 = found.find((f) => f.packages.join() === "packages/p1,packages/p2")!;
    const ui = found.find((f) => f.packages.join() === "packages/api,packages/ui")!;
    expect(p1.changeCost).toBeGreaterThan(2);
    expect(p1.changeCost).toBeLessThanOrEqual(4);
    expect(ui.changeCost).toBeGreaterThan(p1.changeCost);
    expect(ui.changeCost).toBeLessThanOrEqual(12);
  });

  test("findings are ranked by that cost", async () => {
    const all = await findings();
    const costs = all.map((f) => f.changeCost);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
  });
});

describe("follower", () => {
  test("changing the dependant usually changes what it depends on, and not the other way round", async () => {
    const found = byKind(await findings(), "follower");
    expect(found.map((f) => f.packages)).toEqual([["packages/app", "packages/shared"]]);
    expect(found[0]!.evidence).toMatchObject({ shared: 19, confidenceFromTo: 0.826, confidenceToFrom: 0.352 });
  });

  test("it needs the dependency: a package that co-changes with one it does not depend on is not a follower", async () => {
    const found = byKind(await findings(), "follower");
    expect(found.some((f) => f.packages.includes("packages/helper"))).toBe(false);
  });

  test("guidelines come from config", async () => {
    const strict = await withPackageSettings(repo, { minLift: 2 }, () => findings());
    expect(byKind(strict, "follower")).toEqual([]);
  });
});

describe("crossing-unit", () => {
  test("a file whose co-change partners lie mostly in another package, more than its own package's do", async () => {
    const found = byKind(await findings(), "crossing-unit");
    expect(found.map((f) => f.unit)).toEqual(["packages/helper/src/toOrphan.ts"]);
    expect(found[0]).toMatchObject({ packages: ["packages/helper", "packages/orphan"] });
    expect(found[0]!.evidence).toMatchObject({ partnersInOther: 5, partnersInOwn: 0, share: 1 });
  });

  test("a whole package changing with another is the packages' finding, not each file's", async () => {
    const units = byKind(await findings(), "crossing-unit").map((f) => f.unit);
    expect(units.some((unit) => unit?.endsWith("/work.ts"))).toBe(false);
  });
});

describe("wide-change", () => {
  test("is a finding about the repository, from the share of changes touching three or more packages", async () => {
    const [wide] = byKind(await findings(), "wide-change");
    expect(wide).toMatchObject({ id: "wide-change:repository", packages: [] });
    expect(wide!.evidence).toMatchObject({ wide: 5, changes: 97, packagesPerWideChange: 3 });
    expect(wide!.evidence.mostOften).toEqual(["packages/app", "packages/helper", "packages/shared"]);
  });

  test("below the configured share nothing is raised", async () => {
    const found = await withPackageSettings(repo, { wideChangeShare: 0.5 }, () => findings());
    expect(byKind(found, "wide-change")).toEqual([]);
  });
});

describe("low-closure", () => {
  test("a package is judged only against packages of comparable share, and only when there are enough of them", async () => {
    const found = await withPackageSettings(repo, { minComparable: 8 }, () => findings());
    expect(byKind(found, "low-closure")).toEqual([]);
  });

  test("by default the packages that never change alone are the lowest quartile of their comparable group", async () => {
    const found = byKind(await findings(), "low-closure");
    expect(found.map((f) => f.packages[0]).sort()).toEqual(["packages/lib-extra", "packages/p1", "packages/p2"]);
    expect(found.find((f) => f.packages[0] === "packages/p1")!.evidence).toMatchObject({ closure: 0, comparable: 5, crossing: 4, changes: 4 });
  });

  test("among comparable packages, one in the lowest quartile is raised, with the count of its crossing changes", async () => {
    const found = byKind(await withPackageSettings(repo, { minComparable: 3 }, () => findings()), "low-closure");
    const app = found.find((f) => f.packages[0] === "packages/app")!;
    expect(app.evidence).toMatchObject({ closure: 0.13, comparable: 4, crossing: 20 });
    // packages with fewer than a quarter of the comparable group's closure are the ones raised
    expect(found.map((f) => f.packages[0])).not.toContain("packages/shared");
  });
});

describe("tentative findings", () => {
  test("a package inside the grace period holds its findings as tentative", async () => {
    const found = await withPackageSettings(repo, { graceDays: 2000 }, () => findings());
    expect(found.filter((f) => f.packages.length > 0).every((f) => f.tentative)).toBe(true);
    // by default only what involves the package added a month before the end is tentative
    expect((await findings()).filter((f) => f.tentative).every((f) => f.packages.includes("packages/young"))).toBe(true);
  });
});

test("a package argument narrows the findings to those about it", async () => {
  const found = await findings("packages/ui");
  expect(found.length).toBeGreaterThan(0);
  expect(found.every((f) => f.packages.includes("packages/ui"))).toBe(true);
});

test("a package that does not exist is a usage error", async () => {
  const run = await packagesRun(repo, "cohesion", "packages/nowhere");
  expect(run.code).toBe(2);
  expect(run.stderr).toContain("is not a package");
});
