import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "../support/golden.ts";
import { packages, packagesRun, withPackageSettings } from "./support/run.ts";
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
  unit: string | null;
  evidence: Record<string, any>;
}

async function boundaries(...args: string[]) {
  const { document, stdout } = await packages(repo, "boundaries", ...args);
  return { findings: document.results as Finding[], document, stdout };
}

const named = (found: Finding[], kind: string): Finding[] => found.filter((f) => f.kind === kind);

describe("deep-import", () => {
  test("a consumer importing a file of a package that is not one of its entry points", async () => {
    const { findings } = await boundaries();
    const [deep, ...rest] = named(findings, "deep-import");
    expect(rest).toEqual([]);
    expect(deep).toMatchObject({ id: "deep-import:packages/api->packages/helper", principle: "boundary", packages: ["packages/helper", "packages/api"] });
    expect(deep!.evidence).toMatchObject({ files: ["packages/helper/src/secret.ts"], fileCount: 1, importers: 1, entries: ["packages/helper/src/index.ts"] });
  });

  test("a package whose manifest limits its public files with exports has no files to import past them", async () => {
    // shared and lib name their entry in exports, and are imported through it
    const { findings } = await boundaries();
    expect(named(findings, "deep-import").some((f) => f.packages[0] === "packages/shared" || f.packages[0] === "packages/lib")).toBe(false);
  });

  test("a package's own tests are not its consumers", async () => {
    const { findings } = await boundaries("packages/helper");
    expect(named(findings, "deep-import").every((f) => f.packages[0] === "packages/helper" && f.packages[1] !== "packages/helper")).toBe(true);
  });
});

describe("undeclared-dependency", () => {
  test("a package used without being declared, internal or outside, whether production or test code uses it", async () => {
    const { findings } = await boundaries();
    const undeclared = named(findings, "undeclared-dependency");
    expect(undeclared.map((f) => f.packages[0])).toEqual(["packages/api", "packages/helper", "packages/orphan"]);
    const orphan = undeclared.find((f) => f.packages[0] === "packages/orphan")!;
    expect(orphan.evidence).toMatchObject({ dependencies: ["@acme/shared"], internal: ["@acme/shared"], testsOnly: [] });
    const helper = undeclared.find((f) => f.packages[0] === "packages/helper")!;
    expect(helper.evidence).toMatchObject({ dependencies: ["@acme/api"], testsOnly: ["@acme/api"] });
  });

  test("an outside package resolved through the workspace root's manifest is undeclared, and says so", async () => {
    const { findings } = await boundaries();
    const api = named(findings, "undeclared-dependency").find((f) => f.packages[0] === "packages/api")!;
    expect(api.evidence).toMatchObject({ dependencies: ["html-escaper"], internal: [], declaredAtRoot: ["html-escaper"] });
  });

  test("a package declared and used is not undeclared", async () => {
    const { findings } = await boundaries();
    expect(named(findings, "undeclared-dependency").some((f) => f.packages[0] === "packages/ui")).toBe(false);
  });
});

describe("unused-dependency", () => {
  test("a declared runtime dependency that nothing in the package imports", async () => {
    const { findings } = await boundaries();
    const unused = named(findings, "unused-dependency");
    expect(unused.map((f) => [f.packages[0], f.evidence.dependencies])).toEqual([
      ["packages/app", ["@acme/ui"]],
      ["packages/lib", ["left-pad"]],
      ["packages/ui", ["@acme/orphan"]],
    ]);
  });

  test("a dependency used only by a package's tests is used", async () => {
    // app declares testkit as a development dependency and imports it from its tests
    const { findings } = await boundaries("packages/app");
    expect(named(findings, "unused-dependency").flatMap((f) => f.evidence.dependencies as string[])).not.toContain("@acme/testkit");
  });
});

describe("purpose-mismatch", () => {
  test("a package declared for reuse that has one consumer", async () => {
    const { findings } = await withPackageSettings(repo, { byPackage: { "packages/helper": { purpose: "reuse" } } }, boundaries);
    const [mismatch] = named(findings, "purpose-mismatch");
    expect(mismatch).toMatchObject({ id: "purpose-mismatch:packages/helper->reuse", packages: ["packages/helper"] });
    expect(mismatch!.evidence).toMatchObject({ purpose: "reuse", consumers: 1 });
  });

  test("a package declared to enforce a boundary that its consumers go around", async () => {
    const { findings } = await withPackageSettings(repo, { byPackage: { "packages/helper": { purpose: "enforcement" } } }, boundaries);
    const [mismatch] = named(findings, "purpose-mismatch");
    expect(mismatch!.evidence).toMatchObject({ purpose: "enforcement", deepImporters: ["packages/api"] });
  });

  test("with no declared purpose there is nothing to contradict", async () => {
    const { findings } = await boundaries();
    expect(named(findings, "purpose-mismatch")).toEqual([]);
  });

  test("a purpose the evidence supports is not a mismatch", async () => {
    const { findings } = await withPackageSettings(repo, { byPackage: { "packages/shared": { purpose: "reuse" } } }, boundaries);
    expect(named(findings, "purpose-mismatch")).toEqual([]);
  });
});

describe("narrowing to one package", () => {
  test("lists the findings about it, as the deep-importer or the package imported", async () => {
    const { findings } = await boundaries("packages/helper");
    expect(findings.map((f) => f.id)).toEqual(["deep-import:packages/api->packages/helper", "undeclared-dependency:packages/helper"]);
  });

  test("a package that does not exist is a usage error", async () => {
    expect((await packagesRun(repo, "boundaries", "packages/nowhere")).code).toBe(2);
  });
});

test("packages the structural layer cannot read are listed as unavailable", async () => {
  const fixture = manifestsRepository();
  try {
    const { document } = await packages(fixture, "boundaries");
    expect(document.results).toEqual([]);
    expect((document.unavailable as { package: string; findings: string[] }[]).find((u) => u.package === "crates/a")!.findings).toEqual(["deep-import", "undeclared-dependency", "unused-dependency"]);
  } finally {
    fixture.dispose();
  }
});

test("golden", async () => {
  expectGolden("workspace", "packages.boundaries", (await boundaries()).stdout);
});
