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
  aboveGuideline: boolean;
  summary: string;
}

async function findings(...args: string[]): Promise<Finding[]> {
  return (await packages(repo, "cohesion", ...args)).document.results as Finding[];
}

const byKind = (all: Finding[], kind: string) => all.filter((f) => f.kind === kind);
const reaching = (all: Finding[], kind: string) => byKind(all, kind).filter((f) => f.aboveGuideline);
const below = (all: Finding[], kind: string) => byKind(all, kind).filter((f) => !f.aboveGuideline);

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
    const all = await findings();
    expect(reaching(all, "always-together").map((f) => f.packages.join())).not.toContain("packages/app,packages/shared");
    // it is still listed, below the guideline, with the confidence that fell short
    const row = below(all, "always-together").find((f) => f.packages.join() === "packages/app,packages/shared");
    expect(row?.summary).toMatch(/\(below the guideline: lowest confidence 35% against 60%\)$/);
  });

  test("a pair over the evidence floors that misses the confidence guideline is listed below it, with the confidence and the guideline", async () => {
    const found = await withPackageSettings(repo, { minConfidence: 0.9 }, () => findings());
    const ui = byKind(found, "always-together").find((f) => f.packages.join() === "packages/api,packages/ui")!;
    expect(ui.aboveGuideline).toBe(false);
    expect(ui.summary).toMatch(/\(below the guideline: lowest confidence 80% against 90%\)$/);
    expect(found.findIndex((f) => !f.aboveGuideline)).toBeGreaterThan(-1);
    expect(found.slice(found.findIndex((f) => !f.aboveGuideline)).every((f) => !f.aboveGuideline)).toBe(true);
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
    const costs = (await findings()).filter((f) => f.aboveGuideline).map((f) => f.changeCost);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
  });
});

describe("follower", () => {
  test("changing the dependant usually changes what it depends on, and not the other way round", async () => {
    const found = reaching(await findings(), "follower");
    expect(found.map((f) => f.packages)).toEqual([["packages/app", "packages/shared"]]);
    expect(found[0]!.evidence).toMatchObject({ shared: 19, confidenceFromTo: 0.826, confidenceToFrom: 0.352 });
  });

  test("it needs the dependency: a package that co-changes with one it does not depend on is not a follower", async () => {
    const found = byKind(await findings(), "follower");
    expect(found.some((f) => f.packages.includes("packages/helper"))).toBe(false);
  });

  test("guidelines come from config", async () => {
    const strict = await withPackageSettings(repo, { minLift: 2 }, () => findings());
    expect(reaching(strict, "follower")).toEqual([]);
    expect(below(strict, "follower").find((f) => f.packages.join() === "packages/app,packages/shared")!.summary).toMatch(/\(below the guideline: lift [\d.]+ against 2\)$/);
    const stricter = await withPackageSettings(repo, { followerReverseConfidence: 0.1 }, () => findings());
    expect(below(stricter, "follower").find((f) => f.packages.join() === "packages/app,packages/shared")!.summary).toContain("reverse confidence 35% against at most 10%");
  });
});

describe("crossing-unit", () => {
  test("a file whose co-change partners lie mostly in another package, more than its own package's do", async () => {
    const found = reaching(await findings(), "crossing-unit");
    expect(found.map((f) => f.unit)).toEqual(["packages/helper/src/toOrphan.ts"]);
    expect(found[0]).toMatchObject({ packages: ["packages/helper", "packages/orphan"] });
    expect(found[0]!.evidence).toMatchObject({ partnersInOther: 5, partnersInOwn: 0, share: 1 });
  });

  test("a whole package changing with another is the packages' finding, not each file's", async () => {
    const units = reaching(await findings(), "crossing-unit").map((f) => f.unit);
    expect(units.some((unit) => unit?.endsWith("/work.ts"))).toBe(false);
  });
});

describe("crossing-unit below the guideline", () => {
  test("a file that changes with another package but misses the share or the margin is listed after the others, with what fell short", async () => {
    const found = await findings();
    const rows = below(found, "crossing-unit");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.summary).toMatch(/\(below the guideline: .*against/);
    const strict = await withPackageSettings(repo, { crossingUnitShare: 1 }, () => findings());
    expect(reaching(strict, "crossing-unit")).toEqual([]);
    expect(below(strict, "crossing-unit").find((f) => f.unit === "packages/helper/src/toOrphan.ts")!.summary).toMatch(/\(below the guideline: 100% of partners in packages\/orphan against more than 100%\)$/);
  });
});

describe("wide-change", () => {
  test("is a finding about the repository, from the share of changes touching three or more packages", async () => {
    const [wide] = byKind(await findings(), "wide-change");
    expect(wide).toMatchObject({ id: "wide-change:repository", packages: [] });
    expect(wide!.evidence).toMatchObject({ wide: 5, changes: 97, packagesPerWideChange: 3 });
    expect(wide!.evidence.mostOften).toEqual(["packages/app", "packages/helper", "packages/shared"]);
  });

  test("below the configured share it is still listed, after the others, labelled with the share and the guideline", async () => {
    const found = await withPackageSettings(repo, { wideChangeShare: 0.5 }, () => findings());
    const [wide] = byKind(found, "wide-change");
    expect(wide).toMatchObject({ id: "wide-change:repository", aboveGuideline: false });
    expect(wide!.summary).toMatch(/\(below the guideline: \d+% of changes against 50%\)$/);
    const first = found.findIndex((f) => !f.aboveGuideline);
    expect(found.slice(first).every((f) => !f.aboveGuideline)).toBe(true);
    expect(found.slice(first).map((f) => f.id)).toContain("wide-change:repository");
  });
});

describe("low-closure", () => {
  test("a package is judged only against packages of comparable share, and only when there are enough of them", async () => {
    const found = await withPackageSettings(repo, { minComparable: 8 }, () => findings());
    expect(byKind(found, "low-closure")).toEqual([]);
  });

  test("a package judged with enough comparable packages is listed below the guideline when its closure is above the lowest quartile", async () => {
    const found = await findings();
    const rows = below(found, "low-closure");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.summary).toMatch(/\(below the guideline: closure \d+% against \d+% at the lowest quartile of \d+ comparable packages\)$/);
      expect(row.evidence.closure as number).toBeGreaterThan(row.evidence.quartile as number);
    }
  });

  test("by default the packages that never change alone are the lowest quartile of their comparable group", async () => {
    const found = reaching(await findings(), "low-closure");
    expect(found.map((f) => f.packages[0]).sort()).toEqual(["packages/lib-extra", "packages/p1", "packages/p2"]);
    expect(found.find((f) => f.packages[0] === "packages/p1")!.evidence).toMatchObject({ closure: 0, comparable: 5, crossing: 4, changes: 4 });
  });

  test("among comparable packages, one in the lowest quartile is raised, with the count of its crossing changes", async () => {
    const found = reaching(await withPackageSettings(repo, { minComparable: 3 }, () => findings()), "low-closure");
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
