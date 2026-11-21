import { afterAll, beforeAll, expect, test } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { runStructure } from "../support/run.ts";
import { packages } from "./support/run.ts";
import { workspaceRepository } from "./support/workspace.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = workspaceRepository();
});
afterAll(() => repo.dispose());

test("every kind of finding the commands raise has a rule that explain describes", async () => {
  const kinds = new Set<string>();
  for (const subcommand of ["cohesion", "coupling", "boundaries"]) {
    for (const finding of (await packages(repo, subcommand)).document.results as { kind: string }[]) kinds.add(finding.kind);
  }
  const listing = await runStructure(repo.path, ["explain"]);
  for (const kind of kinds) expect(listing.stdout, `no rule for ${kind}`).toContain(`  ${kind}`);
  expect(kinds.size).toBeGreaterThan(15);
});

test("a rule says what raises the finding and that it proves nothing", async () => {
  const run = await runStructure(repo.path, ["explain", "zone-of-pain"]);
  expect(run.code).toBe(0);
  expect(run.stdout).toContain("zone-of-pain: Concrete, widely depended on and still changing");
  expect(run.stdout).toContain("zoneDistance");
  expect(run.stdout).toContain("never proves a fault");
});

test("the rules of the packaging findings are named like the findings", async () => {
  for (const kind of ["package-cycle", "hidden-cycle", "deep-import", "undeclared-dependency", "volatile-interface", "pass-through-package"]) {
    const run = await runStructure(repo.path, ["explain", kind]);
    expect(run.code, kind).toBe(0);
    expect(run.stdout.startsWith(`${kind}:`)).toBe(true);
  }
});
