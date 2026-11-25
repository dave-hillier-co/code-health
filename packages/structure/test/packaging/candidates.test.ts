import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "../support/golden.ts";
import { packages, packagesRun, withPackageSettings } from "./support/run.ts";
import { crossChecksRepository } from "./support/crosschecks.ts";
import { workspaceRepository } from "./support/workspace.ts";

let workspace: GitFixture;
let crossChecks: GitFixture;
beforeAll(() => {
  workspace = workspaceRepository();
  crossChecks = crossChecksRepository();
});
afterAll(() => {
  workspace.dispose();
  crossChecks.dispose();
});

interface Candidate {
  id: string;
  kind: string;
  status: string;
  packages: string[];
  into: string | null;
  unit: string | null;
  parts: { exports: string[]; consumers: string[] }[] | null;
  findings: string[];
  against: { kind: string; hard: boolean; detail: string }[];
  changeCost: number;
  tentative: boolean;
  step: number;
  also: string[];
  dependants: string[] | null;
  handoff: string | null;
}

interface Withheld {
  kind: string;
  packages: string[];
  reason: string;
  assumed: string[];
  question: string | null;
  candidate: Candidate;
}

async function candidates(fixture: GitFixture, ...args: string[]) {
  const { document, stdout } = await packages(fixture, "candidates", ...args);
  const rows = document.results as Candidate[];
  return { rows, byId: (id: string) => rows.find((c) => c.id === id), document, stdout };
}

describe("merge", () => {
  test("a package nothing is reused from goes into its one consumer, with the findings that say so", async () => {
    const { byId } = await candidates(workspace);
    const merge = byId("merge:packages/helper->packages/api")!;
    expect(merge).toMatchObject({ kind: "merge", status: "proposed", packages: ["packages/helper", "packages/api"], into: "packages/api", step: 4 });
    expect(merge.findings).toEqual(["single-consumer:packages/helper"]);
  });

  test("findings about one pair become one candidate, and a package cycle it would end is noted", async () => {
    const { byId } = await candidates(workspace);
    const merge = byId("merge:packages/p2->packages/p1")!;
    expect(merge.findings).toEqual(["always-together:packages/p1->packages/p2", "single-consumer:packages/p2"]);
    expect(merge.also).toEqual(["package-cycle:packages/p1"]);
    expect(merge.changeCost).toBeGreaterThan(2);
  });

  test("a pass-through package merges into the package whose names it passes along, which outranks the consumer's wish", async () => {
    const { byId } = await candidates(workspace);
    const merge = byId("merge:packages/wrap->packages/ui")!;
    expect(merge.findings).toEqual(["pass-through-package:packages/wrap", "single-consumer:packages/ui"]);
  });

  test("an entry point is never the one merged away", async () => {
    const { rows } = await candidates(workspace);
    expect(rows.filter((c) => c.kind === "merge").every((c) => c.packages[0] !== "packages/app")).toBe(true);
  });

  test("a package nobody can see the consumers of is withheld, not proposed", async () => {
    const { rows, document } = await candidates(workspace);
    // its manifest can still be corrected: that changes nothing a consumer outside could depend on
    const changesThem = rows.filter((c) => ["merge", "split", "move-unit", "narrow-interface"].includes(c.kind));
    expect(changesThem.some((c) => c.packages.includes("packages/lib") || c.packages.includes("packages/lib-extra"))).toBe(false);
    const withheld = document.withheld as Withheld[];
    const tiny = withheld.find((w) => w.kind === "merge" && w.packages.join() === "packages/lib-extra,packages/ui")!;
    expect(tiny.reason).toBe(
      'packages/lib-extra is treated as published because its manifest does not mark it internal ("private": true in package.json) and no config says otherwise: its consumers outside the repository cannot be seen, so nothing is proposed',
    );
    expect(tiny.assumed).toEqual(["packages/lib-extra"]);
    expect(tiny.question).toBe(
      'Does packages/lib-extra have consumers outside this repository? If not, set structure.packages.byPackage["packages/lib-extra"].published to false and run packages candidates again.',
    );
    expect(tiny.candidate).toMatchObject({ id: "merge:packages/lib-extra->packages/ui", kind: "merge", into: "packages/ui", findings: ["tiny:packages/lib-extra"] });
  });

  test("a package that config declares published is withheld with no question to ask", async () => {
    const { document } = await withPackageSettings(workspace, { byPackage: { "packages/lib-extra": { published: true } } }, () => candidates(workspace));
    const tiny = (document.withheld as Withheld[]).find((w) => w.kind === "merge" && w.packages.join() === "packages/lib-extra,packages/ui")!;
    expect(tiny.reason).toBe("packages/lib-extra is declared published in config: its consumers outside the repository cannot be seen, so nothing is proposed");
    expect(tiny).toMatchObject({ assumed: [], question: null });
  });

  test("a declared purpose that the evidence does not contradict argues against, softly", async () => {
    const { byId } = await withPackageSettings(workspace, { byPackage: { "packages/helper": { purpose: "ownership" } } }, () => candidates(workspace));
    const merge = byId("merge:packages/helper->packages/api")!;
    expect(merge.status).toBe("proposed");
    expect(merge.against).toEqual([{ kind: "declared-purpose", hard: false, detail: "packages/helper is declared for ownership, and the evidence does not contradict it", packages: ["packages/helper"] }]);
  });

  test("a purpose of reuse that the evidence contradicts no longer argues against", async () => {
    const { byId } = await withPackageSettings(workspace, { byPackage: { "packages/helper": { purpose: "reuse" } } }, () => candidates(workspace));
    expect(byId("merge:packages/helper->packages/api")!.against).toEqual([]);
  });

  test("packages that ship in different deployables argue against, softly", async () => {
    const settings = { byPackage: { "packages/helper": { deployables: ["web"] }, "packages/api": { deployables: ["worker"] } } };
    const { byId } = await withPackageSettings(workspace, settings, () => candidates(workspace));
    const merge = byId("merge:packages/helper->packages/api")!;
    expect(merge.status).toBe("proposed");
    expect(merge.against.map((a) => a.kind)).toEqual(["different-deployables"]);
  });

  test("a merge whose result would be disjoint-reuse is blocked: the tool would recommend the split straight back", async () => {
    const { byId } = await candidates(crossChecks);
    const merge = byId("merge:packages/lib3->packages/lib2") ?? byId("merge:packages/lib2->packages/lib3")!;
    expect(merge.findings).toEqual(["always-together:packages/lib2->packages/lib3"]);
    expect(merge.status).toBe("blocked");
    expect(merge.against).toEqual([expect.objectContaining({ kind: "creates-disjoint-reuse", hard: true })]);
    expect(merge.against[0]!.detail).toContain("disjoint parts");
  });
});

describe("split", () => {
  test("a package whose consumers use disjoint parts splits along its export components", async () => {
    const { byId } = await candidates(workspace);
    const split = byId("split:packages/shared")!;
    expect(split).toMatchObject({ kind: "split", status: "proposed", step: 5, packages: ["packages/shared"] });
    expect(split.parts).toEqual([
      { exports: ["packages/shared/src/format.ts#formatDate"], consumers: ["packages/ui"] },
      { exports: ["packages/shared/src/ids.ts#newId", "packages/shared/src/money.ts#formatMoney"], consumers: ["packages/api", "packages/orphan"] },
      { exports: ["packages/shared/src/log.ts#log"], consumers: ["packages/app"] },
    ]);
    expect(split.findings).toEqual(["disjoint-reuse:packages/shared", "dumping-ground:packages/shared"]);
  });

  test("a split whose parts change together is blocked: they would be always-together packages", async () => {
    const { byId } = await candidates(crossChecks);
    const split = byId("split:packages/big")!;
    expect(split.status).toBe("blocked");
    expect(split.against).toEqual([expect.objectContaining({ kind: "creates-always-together", hard: true })]);
    expect(split.against[0]!.detail).toContain("changed together in 7 changes");
  });

  test("a published package is withheld", async () => {
    const { rows, document } = await candidates(workspace);
    expect(rows.some((c) => c.id === "split:packages/lib")).toBe(false);
    expect((document.withheld as { kind: string; packages: string[] }[]).some((w) => w.kind === "split" && w.packages[0] === "packages/lib")).toBe(true);
  });
});

describe("move-unit", () => {
  test("a unit whose co-change partners are in another package moves there", async () => {
    const { byId } = await candidates(workspace);
    const move = byId("move-unit:packages/helper/src/toOrphan.ts->packages/orphan")!;
    expect(move).toMatchObject({ status: "proposed", unit: "packages/helper/src/toOrphan.ts", into: "packages/orphan", step: 2, packages: ["packages/helper", "packages/orphan"] });
    expect(move.against).toEqual([]);
  });

  test("a follower relation with no unit behind it is a candidate for the pair, with no unit named", async () => {
    const { byId } = await candidates(workspace);
    const move = byId("move-unit:packages/shared->packages/app")!;
    expect(move).toMatchObject({ unit: null, into: "packages/app", findings: ["follower:packages/app->packages/shared"] });
  });

  test("a move that would close a package cycle is blocked", async () => {
    const { byId } = await candidates(crossChecks);
    const move = byId("move-unit:packages/core/src/util.ts->packages/edge")!;
    expect(move.status).toBe("blocked");
    expect(move.against.map((a) => a.kind)).toEqual(["creates-package-cycle"]);
    expect(move.against[0]!.detail).toContain("packages/core, packages/edge");
  });

  test("a unit with consumers on both sides is blocked", async () => {
    const { byId } = await candidates(crossChecks);
    const move = byId("move-unit:packages/core/src/shared.ts->packages/edge")!;
    expect(move.status).toBe("blocked");
    expect(move.against.map((a) => a.kind)).toContain("consumers-on-both-sides");
    expect(move.against.find((a) => a.kind === "consumers-on-both-sides")!.detail).toBe("packages/core/src/shared.ts is imported by 1 file of packages/core and 1 of packages/edge");
  });
});

describe("narrow-interface, fix-manifest and break-dependency", () => {
  test("a deep import is a candidate to narrow the interface it goes around", async () => {
    const { byId } = await candidates(workspace);
    expect(byId("narrow-interface:packages/helper")).toMatchObject({ findings: ["deep-import:packages/api->packages/helper"], step: 3 });
  });

  test("manifest corrections have nothing against them and come first among the steps", async () => {
    const { rows, byId } = await candidates(workspace);
    const fix = byId("fix-manifest:packages/orphan")!;
    expect(fix).toMatchObject({ kind: "fix-manifest", status: "proposed", against: [], step: 1, findings: ["undeclared-dependency:packages/orphan"] });
    expect(rows.filter((c) => c.kind === "fix-manifest").map((c) => c.packages[0])).toEqual(["packages/api", "packages/app", "packages/helper", "packages/lib", "packages/orphan", "packages/ui"]);
  });

  test("a package cycle is handed to the structure skill with the command that gives its evidence pack", async () => {
    const { byId } = await candidates(workspace);
    expect(byId("break-dependency:packages/p1->packages/p2")).toMatchObject({
      findings: ["package-cycle:packages/p1"],
      handoff: 'structure evidence "packages/p1->packages/p2" --level package',
    });
  });
});

test("a package in the zone of pain is one candidate that lists the packages depending on it", async () => {
  const { rows, byId } = await candidates(workspace);
  expect(rows.filter((c) => c.findings.includes("zone-of-pain:packages/shared")).map((c) => c.id)).toEqual(["break-dependency:packages/shared"]);
  expect(byId("break-dependency:packages/shared")).toMatchObject({
    packages: ["packages/shared"],
    dependants: ["packages/api", "packages/app", "packages/orphan", "packages/ui"],
    // the dependant that changed with it most is the first dependency to look at
    handoff: 'structure evidence "packages/app->packages/shared" --level package',
  });
});

describe("ranking", () => {
  test("candidates are ranked by the change cost they address, with blocked ones last", async () => {
    const { rows } = await candidates(workspace);
    const proposed = rows.filter((c) => c.status === "proposed").map((c) => c.changeCost);
    expect(proposed).toEqual([...proposed].sort((a, b) => b - a));
    const firstBlocked = rows.findIndex((c) => c.status === "blocked");
    expect(rows.slice(firstBlocked).every((c) => c.status === "blocked")).toBe(true);
  });

  test("--kind narrows the list", async () => {
    const { rows } = await candidates(workspace, "--kind", "merge");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((c) => c.kind === "merge")).toBe(true);
  });

  test("an unknown kind is a usage error", async () => {
    expect((await packagesRun(workspace, "candidates", "--kind", "reorganise")).code).toBe(2);
  });
});

test("the packages a candidate involves that are inside the grace period make it tentative", async () => {
  const { byId } = await candidates(workspace);
  expect(byId("merge:packages/young->packages/app")!.tentative).toBe(true);
  expect(byId("merge:packages/helper->packages/api")!.tentative).toBe(false);
});

test("goldens", async () => {
  expectGolden("workspace", "packages.candidates", (await candidates(workspace)).stdout);
  expectGolden("crosschecks", "packages.candidates", (await candidates(crossChecks)).stdout);
});
