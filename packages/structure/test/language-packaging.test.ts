import { readdirSync, readFileSync, statSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { fixtureCases, readExpected, type FixtureCase } from "@code-health/fixtures/language-conformance";
import { GitFixture, type Change } from "@code-health/fixtures/git-fixture";
import { adapterById, overrideSupportedAdapters, registeredAdapters } from "@code-health/parse/languages";
import { runStructure } from "./support/run.ts";

/**
 * The packaging half of structure's conformance (suite.md, Testing): each folder under
 * `fixtures/languages/<id>/packaging` is a small workspace, committed to a real git repository and run through
 * `structure packages`. Its expected.json holds what was read off the workspace by hand: the packages with
 * their ecosystem, exported types and abstractness, and the boundary findings.
 */
/** Every file under a directory, relative to it, with forward slashes. */
function filesOf(directory: string, relative = ""): string[] {
  return readdirSync(`${directory}${relative}`).flatMap((name) => {
    const path = `${relative}${name}`;
    return statSync(`${directory}${path}`).isDirectory() ? filesOf(directory, `${path}/`) : [path];
  });
}

function commitOf(fixture: FixtureCase): GitFixture {
  const changes: Change[] = filesOf(fixture.directory)
    .filter((path) => path !== "expected.json")
    .sort()
    .map((path) => ({ op: "add", path, content: readFileSync(`${fixture.directory}${path}`, "utf8") }));
  return GitFixture.build([{ type: "commit", message: "Add the workspace", date: "2024-01-10T09:00:00Z", changes }]);
}

async function results(repo: GitFixture, subcommand: string): Promise<Record<string, any>[]> {
  const run = await runStructure(repo.path, ["packages", subcommand, "--json", "--limit", "all"]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  return (JSON.parse(run.stdout) as { results: Record<string, any>[] }).results;
}

interface PackagingExpected {
  packages: Record<string, { ecosystem: string; exportedTypes: number; abstractness: number; abstractnessWeak: boolean; consumers: string[] }>;
  findings: string[];
}

describe.each(registeredAdapters.map((adapter) => adapter.id))("%s: the packaging fixtures", (id) => {
  beforeAll(() => overrideSupportedAdapters([adapterById(id)!]));
  afterAll(() => overrideSupportedAdapters(undefined));

  describe.each(fixtureCases(id, "packaging"))("$name", (fixture) => {
    const expected = readExpected<PackagingExpected>(fixture);
    let repo: GitFixture;
    beforeAll(() => {
      repo = commitOf(fixture);
    });
    afterAll(() => repo?.dispose());

    it("reads the packages, their exported types and their abstractness as counted by hand", async () => {
      const rows = await results(repo, "list");
      const actual = Object.fromEntries(
        rows.map((row) => [row.id, { ecosystem: row.ecosystem, exportedTypes: row.exportedTypes, abstractness: row.abstractness, abstractnessWeak: row.abstractnessWeak, consumers: row.consumers }]),
      );
      expect(actual).toEqual(expected.packages);
    });

    it("raises the boundary findings the workspace was built to have, and no others", async () => {
      const found = await results(repo, "boundaries");
      expect(found.map((finding) => `${finding.kind} ${finding.packages.join(" ")} | ${finding.summary}`)).toEqual(expected.findings);
    });

    it("reads every package it expects through one of the adapter's ecosystems", () => {
      const ecosystems = adapterById(id)!.packaging.ecosystems;
      for (const [name, row] of Object.entries(expected.packages)) expect(ecosystems, `${name} is a ${row.ecosystem} package`).toContain(row.ecosystem);
    });
  });
});
