import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "../support/golden.ts";
import { packages, withPackageSettings } from "./support/run.ts";
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
  evidence: Record<string, any>;
  changeCost: number;
  priority: string;
}

async function coupling(): Promise<Finding[]> {
  return (await packages(repo, "coupling")).document.results as Finding[];
}

const ofKind = (found: Finding[], kind: string) => found.filter((f) => f.kind === kind);

describe("package-cycle", () => {
  test("a cycle in the package graph, with the dependency whose removal breaks it", async () => {
    const [cycle, ...rest] = ofKind(await coupling(), "package-cycle");
    expect(rest).toEqual([]);
    expect(cycle).toMatchObject({ id: "package-cycle:packages/p1", principle: "ADP", packages: ["packages/p1", "packages/p2"] });
    expect(cycle!.evidence).toMatchObject({ size: 2, method: "exact", breakingSet: ["packages/p1->packages/p2"], symbolsAcross: 1, coChangeAcross: 4 });
  });

  test("its cost is the changes that crossed between the packages in it, weighted by recency", async () => {
    const [cycle] = ofKind(await coupling(), "package-cycle");
    expect(cycle!.changeCost).toBeGreaterThan(2);
    expect(cycle!.changeCost).toBeLessThanOrEqual(4);
  });

  test("the same cycle structure uses the workspace's own graph, so a manifest dependency alone makes an edge", async () => {
    // p1 and p2 declare each other in their manifests as well as importing each other
    const found = ofKind(await coupling(), "package-cycle");
    expect(found).toHaveLength(1);
  });
});

describe("hidden-cycle", () => {
  test("a cycle that exists only through a development dependency", async () => {
    const hidden = ofKind(await coupling(), "hidden-cycle").find((f) => f.packages.includes("packages/lib"))!;
    expect(hidden.packages).toEqual(["packages/lib", "packages/testkit"]);
    expect(hidden.priority).toBe("normal");
    expect(hidden.evidence).toMatchObject({ testOnly: false, via: ["packages/lib->packages/testkit:development-dependency"] });
  });

  test("a cycle through test code alone is reported at low priority", async () => {
    const hidden = ofKind(await coupling(), "hidden-cycle").find((f) => f.packages.includes("packages/helper"))!;
    expect(hidden.packages).toEqual(["packages/api", "packages/helper"]);
    expect(hidden.priority).toBe("low");
    expect(hidden.evidence).toMatchObject({ testOnly: true, via: ["packages/helper->packages/api:test-import"] });
  });

  test("a cycle the manifests already show is a package-cycle and not a hidden one", async () => {
    const hidden = ofKind(await coupling(), "hidden-cycle");
    expect(hidden.some((f) => f.packages.includes("packages/p1"))).toBe(false);
  });

  test("low priority findings come last", async () => {
    const found = await coupling();
    expect(found.at(-1)!.priority).toBe("low");
  });
});

describe("against-stability", () => {
  test("a dependency on a package that changes more often per file than the dependant does", async () => {
    const found = ofKind(await coupling(), "against-stability");
    const ids = found.map((f) => f.id);
    expect(ids).toContain("against-stability:packages/wrap->packages/ui");
    const wrap = found.find((f) => f.id === "against-stability:packages/wrap->packages/ui")!;
    expect(wrap).toMatchObject({ principle: "SDP", packages: ["packages/wrap", "packages/ui"] });
    expect(wrap.evidence).toMatchObject({ basis: "change", disagree: true });
    expect(wrap.evidence.volatilityRatio).toBeGreaterThan(11);
  });

  test("a dependency towards the more volatile side is not raised when the dependant is the more volatile", async () => {
    const ids = ofKind(await coupling(), "against-stability").map((f) => f.id);
    expect(ids).not.toContain("against-stability:packages/app->packages/shared");
  });

  test("guidelines are structure's own, from the structure section of the config", async () => {
    const strict = await withPackageSettings(repo, {}, async () => (await packages(repo, "coupling")).document);
    expect(strict.inputs).toMatchObject({ subcommand: "coupling", minVolatilityRatio: 2, minInstabilityGap: 20 });
  });
});

test("golden", async () => {
  expectGolden("workspace", "packages.coupling", (await packages(repo, "coupling")).stdout);
});
