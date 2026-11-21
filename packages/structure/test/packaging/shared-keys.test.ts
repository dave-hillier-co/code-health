import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { packages, withPackageSettings } from "./support/run.ts";
import { workspaceRepository } from "./support/workspace.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = workspaceRepository();
});
afterAll(() => repo.dispose());

interface Finding {
  kind: string;
  packages: string[];
  evidence: Record<string, any>;
}

async function cohesion(): Promise<Finding[]> {
  const { document } = await packages(repo, "cohesion");
  return document.results as Finding[];
}

/** Runs `body` with keys merged into the top level of the fixture's code-health.json, shared by every plugin. */
async function withSharedKeys<T>(keys: Record<string, unknown>, body: () => Promise<T>): Promise<T> {
  const file = join(repo.path, "code-health.json");
  const original = readFileSync(file, "utf8");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(original), ...keys }));
  try {
    return await body();
  } finally {
    writeFileSync(file, original);
  }
}

const kinds = (findings: Finding[], kind: string) => findings.filter((f) => f.kind === kind);

describe("the shared entryPoints", () => {
  test("a package that nothing uses but that holds a configured entry point is not dead", async () => {
    expect(kinds(await cohesion(), "no-consumer").map((f) => f.packages[0])).toEqual(["packages/orphan"]);
    const findings = await withSharedKeys({ entryPoints: ["packages/orphan/src/index.ts"] }, cohesion);
    expect(kinds(findings, "no-consumer")).toEqual([]);
  });

  test("an entry point of another package leaves the orphan reported", async () => {
    const findings = await withSharedKeys({ entryPoints: ["packages/app/**"] }, cohesion);
    expect(kinds(findings, "no-consumer").map((f) => f.packages[0])).toEqual(["packages/orphan"]);
  });
});

describe("the shared vagueNames", () => {
  const quiet = { dumpingNames: [] as string[], dumpingMinContributors: 4 };

  test("a package whose name is vague prompts the dumping-ground check, as dumpingNames does", async () => {
    const without = await withPackageSettings(repo, quiet, cohesion);
    expect(kinds(without, "dumping-ground")).toEqual([]);
    const withName = await withSharedKeys({ vagueNames: ["shared"] }, () => withPackageSettings(repo, quiet, cohesion));
    expect(kinds(withName, "dumping-ground").map((f) => f.packages[0])).toEqual(["packages/shared"]);
    expect(kinds(withName, "dumping-ground")[0]!.evidence.named).toBe(true);
  });
});
