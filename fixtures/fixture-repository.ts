import { readdirSync, readFileSync, statSync } from "node:fs";
import { GitFixture, type Change } from "./git-fixture.ts";
import { areaDirectory, type AreaName } from "./language-conformance.ts";

function filesUnder(directory: string, prefix = ""): string[] {
  return readdirSync(`${directory}${prefix}`)
    .sort()
    .flatMap((name) => (statSync(`${directory}${prefix}${name}`).isDirectory() ? filesUnder(directory, `${prefix}${name}/`) : [`${prefix}${name}`]));
}

/** One conformance fixture case as the changes of a commit that adds it. `expected.json` is left out: it describes the case and is no part of it. */
export function fixtureChanges(language: string, area: AreaName, name: string): Change[] {
  const directory = `${areaDirectory(language, area)}${name}/`;
  return filesUnder(directory)
    .filter((path) => path !== "expected.json")
    .map((path) => ({ op: "add", path, content: readFileSync(`${directory}${path}`, "utf8") }));
}

/** A git repository holding one conformance fixture case as a single commit, for a command that reads a repository and not a directory. */
export function repositoryOfFixture(language: string, area: AreaName, name: string): GitFixture {
  return GitFixture.build([{ type: "commit", message: `Add the ${name} fixture`, date: "2024-01-01T00:00:00+00:00", changes: fixtureChanges(language, area, name) }]);
}
