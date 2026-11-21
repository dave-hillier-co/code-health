import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "../support/golden.ts";
import { packages, withPackageSettings } from "./support/run.ts";
import { manifestsRepository } from "./support/scenarios.ts";
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
  tentative: boolean;
  priority: string;
  changeCost: number;
}

async function cohesion(...args: string[]) {
  const { document, stdout } = await packages(repo, "cohesion", ...args);
  return { findings: document.results as Finding[], document, stdout };
}

const named = (found: Finding[], kind: string): Finding[] => found.filter((f) => f.kind === kind);

describe("common reuse", () => {
  test("partial-use: most consumers of a package use under a quarter of what it exports", async () => {
    const { findings } = await cohesion();
    const [lib, ...others] = named(findings, "partial-use");
    expect(others).toEqual([]);
    expect(lib).toMatchObject({ principle: "CRP", packages: ["packages/lib"] });
    expect(lib!.evidence).toMatchObject({ surface: 5, consumers: 3, smallUsers: 3, medianShare: 0.2 });
    expect(lib!.evidence.shares).toEqual(["packages/app:0.2", "packages/testkit:0.2", "packages/ui:0.2"]);
  });

  test("a package whose consumers each use a quarter or more of it is not partly used", async () => {
    const { findings } = await cohesion();
    expect(named(findings, "partial-use").some((f) => f.packages.includes("packages/shared"))).toBe(false);
  });

  test("disjoint-reuse: export components with consumers that barely overlap are several packages sharing a name", async () => {
    const { findings } = await cohesion();
    const shared = named(findings, "disjoint-reuse").find((f) => f.packages[0] === "packages/shared")!;
    expect(shared.evidence.groups).toEqual(["formatDate:packages/ui", "newId+formatMoney:packages/api+packages/orphan", "log:packages/app"]);
    expect(shared.evidence).toMatchObject({ components: 3, overlap: 0 });
    const lib = named(findings, "disjoint-reuse").find((f) => f.packages[0] === "packages/lib")!;
    expect(lib.evidence.groups).toEqual(["parse:packages/app+packages/testkit", "render:packages/ui"]);
  });

  test("a package with one component is not disjoint", async () => {
    const { findings } = await cohesion();
    expect(named(findings, "disjoint-reuse").some((f) => f.packages.includes("packages/helper"))).toBe(false);
  });

  test("dumping-ground: high fan-in, unrelated parts, frequent change and many contributors", async () => {
    const { findings } = await cohesion();
    const [dumping, ...rest] = named(findings, "dumping-ground");
    expect(rest).toEqual([]);
    expect(dumping!.packages).toEqual(["packages/shared"]);
    expect(dumping!.evidence).toMatchObject({ consumers: 4, components: 3, revisions: 54, contributors: 3, named: true });
    expect(dumping!.changeCost).toBeGreaterThan(10);
  });

  test("dumping-ground needs the fan-in the config asks for", async () => {
    const { findings } = await withPackageSettings(repo, { dumpingMinConsumers: 5 }, cohesion);
    expect(named(findings, "dumping-ground")).toEqual([]);
  });

  test("overexposed: exports that no other package uses, where a package that only re-exports a name still uses it", async () => {
    const { findings } = await cohesion();
    const overexposed = named(findings, "overexposed");
    expect(overexposed.map((f) => f.packages[0])).toEqual(["packages/lib"]);
    expect(overexposed[0]!.evidence).toMatchObject({ unused: 3, surface: 5, names: ["diff", "serialize", "validate"] });
  });

  test("inherited-weight: a consumer pays for outside packages the part it uses does not need", async () => {
    const { findings } = await cohesion();
    const weights = named(findings, "inherited-weight");
    expect(weights.map((f) => f.packages)).toEqual([
      ["packages/lib", "packages/app"],
      ["packages/lib", "packages/testkit"],
      ["packages/lib", "packages/ui"],
    ]);
    expect(weights[0]!.evidence).toMatchObject({ used: 1, surface: 5, acquired: 3, needed: 0, excess: ["ajv", "jsdiff", "yaml"] });
  });

  test("a declared dependency that nothing imports is not weight the consumer acquires", async () => {
    const { findings } = await cohesion();
    expect(named(findings, "inherited-weight").flatMap((f) => f.evidence.excess as string[])).not.toContain("left-pad");
  });
});

describe("reuse and release", () => {
  test("single-consumer: an internal package with one consuming package, past its grace period", async () => {
    const { findings } = await cohesion();
    const ids = named(findings, "single-consumer").map((f) => f.packages[0]).sort();
    expect(ids).toEqual(["packages/api", "packages/helper", "packages/p2", "packages/ui", "packages/wrap"]);
  });

  test("published packages, test support, entry points and young packages are not single-consumer", async () => {
    const { findings } = await cohesion();
    const ids = named(findings, "single-consumer").map((f) => f.packages[0]);
    for (const left of ["packages/lib-extra", "packages/testkit", "packages/app", "packages/young"]) expect(ids).not.toContain(left);
  });

  test("a declared purpose is carried in the evidence, for the skill to weigh", async () => {
    const { findings } = await withPackageSettings(repo, { byPackage: { "packages/helper": { purpose: "enforcement" } } }, cohesion);
    const helper = named(findings, "single-consumer").find((f) => f.packages[0] === "packages/helper")!;
    expect(helper.evidence.purpose).toBe("enforcement");
  });

  test("no-consumer: nothing uses it, it is no entry point, and a declared dependency does not count as use", async () => {
    const { findings } = await cohesion();
    const [orphan, ...rest] = named(findings, "no-consumer");
    expect(rest).toEqual([]);
    expect(orphan).toMatchObject({ packages: ["packages/orphan"], principle: "REP" });
    expect(orphan!.evidence.declaredBy).toEqual(["packages/ui"]);
  });

  test("a declared purpose of deploy is a deployable and not dead", async () => {
    const { findings } = await withPackageSettings(repo, { byPackage: { "packages/orphan": { purpose: "deploy" } } }, cohesion);
    expect(named(findings, "no-consumer")).toEqual([]);
  });

  test("one-deployable: a package that ships in only one of several deployables", async () => {
    const settings = {
      byPackage: {
        "packages/helper": { deployables: ["web"] },
        "packages/shared": { deployables: ["web", "worker"] },
      },
    };
    const { findings } = await withPackageSettings(repo, settings, cohesion);
    const found = named(findings, "one-deployable");
    expect(found.map((f) => f.packages[0])).toContain("packages/helper");
    expect(found.find((f) => f.packages[0] === "packages/helper")!.evidence).toMatchObject({ deployable: "web" });
    expect(found.map((f) => f.packages[0])).not.toContain("packages/shared");
  });

  test("with one deployable nothing ships in only one of several", async () => {
    const { findings } = await cohesion();
    expect(named(findings, "one-deployable")).toEqual([]);
  });

  test("lockstep: published packages whose versions change in the same commits", async () => {
    const { findings } = await cohesion();
    const [lockstep, ...rest] = named(findings, "lockstep");
    expect(rest).toEqual([]);
    expect(lockstep!.packages).toEqual(["packages/lib", "packages/lib-extra"]);
    expect(lockstep!.evidence).toMatchObject({ versionChanges: 3 });
  });

  test("pass-through-package: a package whose exports are re-exports of another's", async () => {
    const { findings } = await cohesion();
    const [wrap, ...rest] = named(findings, "pass-through-package");
    expect(rest).toEqual([]);
    expect(wrap).toMatchObject({ packages: ["packages/wrap"] });
    expect(wrap!.evidence).toMatchObject({ passThroughShare: 1, surface: 1 });
  });

  test("tiny: among the smallest packages, one holding little beside its manifest and entry point", async () => {
    const { findings } = await cohesion();
    const ids = named(findings, "tiny").map((f) => f.packages[0]).sort();
    expect(ids).toEqual(["packages/lib-extra", "packages/wrap", "packages/young"]);
    expect(named(findings, "tiny").find((f) => f.packages[0] === "packages/young")!.tentative).toBe(true);
  });
});

describe("the balance", () => {
  async function balance() {
    const { document } = await cohesion();
    return new Map((document.balance as any[]).map((row) => [row.id as string, row]));
  }

  test("a package that changes often and has one consumer is paying for a boundary and getting little back", async () => {
    const row = (await balance()).get("packages/api")!;
    expect(row.matters).toBe("closure");
    expect(row.reading).toContain("closure matters most");
    expect(row.release.consumers).toEqual(["packages/app"]);
  });

  test("a package that rarely changes and has many consumers has earned its boundary", async () => {
    const row = (await balance()).get("packages/lib")!;
    expect(row.matters).toBe("reuse");
    expect(row.neglected).toEqual(["CRP", "REP"]);
    expect(row.reuse).toMatchObject({ surface: 5, consumers: 3, unused: 3 });
  });

  test("a young package is held as tentative", async () => {
    expect((await balance()).get("packages/young")!.matters).toBe("tentative");
  });

  test("the closure force names the packages a package changes with, and the release force its version history", async () => {
    const rows = await balance();
    expect(rows.get("packages/ui")!.closure.changesWith[0]).toBe("packages/api");
    expect(rows.get("packages/lib")!.release).toMatchObject({ published: true, versionChanges: 3 });
    expect(rows.get("packages/shared")!.release.versionChanges).toBeNull();
  });
});

describe("where the structural layer cannot read", () => {
  test("packages without TypeScript or JavaScript list the findings that are unavailable for them", async () => {
    const fixture = manifestsRepository();
    try {
      const { document } = await packages(fixture, "cohesion");
      const unavailable = document.unavailable as { package: string; reason: string; findings: string[] }[];
      expect(unavailable.map((u) => u.package)).toContain("dotnet/Web");
      expect(unavailable.find((u) => u.package === "dotnet/Web")!.reason).toMatch(/^no .*TypeScript or JavaScript.* for the structural layer to read$/);
      expect(unavailable[0]!.findings).toContain("partial-use");
      expect(document.balance.find((b: any) => b.id === "dotnet/Web").reuse).toBeNull();
    } finally {
      fixture.dispose();
    }
  });
});

test("golden", async () => {
  expectGolden("workspace", "packages.cohesion", (await cohesion()).stdout);
});
