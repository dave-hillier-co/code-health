import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { packages, withPackageSettings } from "./support/run.ts";
import { manifestsRepository } from "./support/scenarios.ts";
import { workspaceRepository } from "./support/workspace.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = workspaceRepository();
});
afterAll(() => repo.dispose());

interface Row {
  id: string;
  abstractness: number | null;
  exportedTypes: number | null;
  abstractnessWeak: boolean;
  instability: number | null;
  distance: number | null;
}

interface Finding {
  id: string;
  kind: string;
  principle: string;
  packages: string[];
  evidence: Record<string, any>;
  aboveGuideline: boolean;
  summary: string;
}

async function rows(fixture: GitFixture = repo): Promise<Map<string, Row>> {
  const { document } = await packages(fixture, "list");
  return new Map((document.results as Row[]).map((r) => [r.id, r]));
}

async function coupling(): Promise<Finding[]> {
  return (await packages(repo, "coupling")).document.results as Finding[];
}

describe("abstractness and distance from the main sequence", () => {
  test("A is the share of exported types that are interfaces or abstract classes, and D is |A + I - 1|", async () => {
    const orphan = (await rows()).get("packages/orphan")!;
    // an interface and an abstract class are its two exported types
    expect(orphan).toMatchObject({ abstractness: 1, exportedTypes: 2, instability: 0.5, distance: 0.5 });
  });

  test("a package that exports no type has A of 0, flagged as weak, and its distance carries the caveat", async () => {
    const shared = (await rows()).get("packages/shared")!;
    expect(shared).toMatchObject({ abstractness: 0, exportedTypes: 0, abstractnessWeak: true, instability: 0, distance: 1 });
  });

  test("packages the structural layer cannot read have neither", async () => {
    const fixture = manifestsRepository();
    try {
      const web = (await rows(fixture)).get("dotnet/Web")!;
      expect(web).toMatchObject({ abstractness: null, exportedTypes: null, distance: null });
    } finally {
      fixture.dispose();
    }
  });
});

describe("zone-of-pain", () => {
  test("concrete, stable, widely depended on, and changing often", async () => {
    const [pain, ...rest] = (await coupling()).filter((f) => f.kind === "zone-of-pain" && f.aboveGuideline);
    expect(rest).toEqual([]);
    expect(pain).toMatchObject({ id: "zone-of-pain:packages/shared", principle: "SAP", packages: ["packages/shared"] });
    expect(pain!.evidence).toMatchObject({ abstractness: 0, instability: 0, ca: 4, revisions: 54, medianRevisions: 6, abstractnessWeak: true });
  });

  test("a package on the pain side of the main sequence but nearer than the guideline is listed after the others, labelled", async () => {
    const all = await coupling();
    const below = all.filter((f) => f.kind === "zone-of-pain" && !f.aboveGuideline);
    expect(below.length).toBeGreaterThan(0);
    for (const finding of below) expect(finding.summary).toMatch(/\(below the guideline: distance [\d.]+ against 0\.5\)$/);
    const first = all.findIndex((f) => !f.aboveGuideline);
    expect(all.slice(first).every((f) => !f.aboveGuideline)).toBe(true);
  });

  test("a stable concrete package that rarely changes is healthy", async () => {
    // lib is concrete (A 0) and has no dependencies (I 0), with three dependants, and changed in few changes
    const ids = (await coupling()).filter((f) => f.kind === "zone-of-pain").map((f) => f.packages[0]);
    expect(ids).not.toContain("packages/lib");
  });

  test("the zone is as far from the main sequence as the config says", async () => {
    const found = await withPackageSettings(repo, { zoneDistance: 1 }, coupling);
    // A + I must be 0 to be that far: shared is exactly there
    expect(found.some((f) => f.kind === "zone-of-pain" && f.packages[0] === "packages/shared")).toBe(true);
    const none = await withPackageSettings(repo, { zoneDistance: 1 }, async () => (await coupling()).filter((f) => f.kind === "zone-of-uselessness" && f.aboveGuideline));
    expect(none).toEqual([]);
  });
});

describe("zone-of-uselessness", () => {
  test("abstract and with few or no dependents", async () => {
    const [useless, ...rest] = (await coupling()).filter((f) => f.kind === "zone-of-uselessness" && f.aboveGuideline);
    expect(rest).toEqual([]);
    expect(useless).toMatchObject({ id: "zone-of-uselessness:packages/orphan", principle: "SAP" });
    expect(useless!.evidence).toMatchObject({ abstractness: 1, exportedTypes: 2, ca: 1 });
  });
});

describe("volatile-interface", () => {
  test("is not raised while the files that define the exports change in under a third of a package's revisions", async () => {
    const found = (await coupling()).filter((f) => f.kind === "volatile-interface");
    expect(found.some((f) => f.aboveGuideline)).toBe(false);
    // it is still listed, labelled with the measured share against the guideline
    expect(found.map((f) => f.summary).every((summary) => /\(below the guideline: \d+% of revisions against 30%\)$/.test(summary))).toBe(true);
  });

  test("a package whose exported surface changes in a large share of its revisions", async () => {
    const found = await withPackageSettings(repo, { volatileInterfaceShare: 0.2 }, coupling);
    const [volatile, ...rest] = found.filter((f) => f.kind === "volatile-interface" && f.aboveGuideline);
    expect(rest).toEqual([]);
    expect(volatile).toMatchObject({ id: "volatile-interface:packages/helper", principle: "SDP" });
    expect(volatile!.evidence).toMatchObject({ surfaceChanges: 3, revisions: 13, consumers: 1 });
    expect(volatile!.evidence.surfaceFiles).toEqual(["packages/helper/src/index.ts"]);
  });
});
