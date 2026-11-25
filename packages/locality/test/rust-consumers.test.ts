import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { repositoryOfFixture } from "@code-health/fixtures/fixture-repository";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { runInProcess } from "@code-health/fixtures/cli-testing";
import { cli } from "../src/cli.ts";
import { runLocality } from "./support/run.ts";

/**
 * Consumers of a Rust file are the files whose `use` reaches a definition in it, through whatever re-exports
 * the path goes. A consumer whose import could not be followed is counted beside the fan-in, and listed.
 */
const fixtures = ["glob-reexports", "derived-names"] as const;
const repos = new Map<string, GitFixture>();
beforeAll(() => {
  for (const name of fixtures) repos.set(name, repositoryOfFixture("rust", "adapter", name));
});
afterAll(() => {
  for (const repo of repos.values()) repo.dispose();
});

interface Row {
  path: string;
  fanIn: number;
  fanInUnresolved: number;
  directCalls: { path: string }[];
  otherRefs: { path: string }[];
  testRefs: { external: string[] };
}

async function analyse(name: (typeof fixtures)[number]): Promise<{ results: Row[]; unresolved: Record<string, number>; unresolvedSample: Record<string, unknown[]>; notices?: string[] }> {
  const run = await runLocality(repos.get(name)!.path, ["analyse", "--json", "--limit", "all"]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  return JSON.parse(run.stdout);
}

const consumersOf = (row: Row): string[] => [...new Set([...row.directCalls, ...row.otherRefs].map((entry) => entry.path))].sort();

describe("consumers through re-exports", () => {
  test("a file whose names a parent re-exports with a glob has the files that import them from the parent as consumers", async () => {
    const { results, unresolved } = await analyse("glob-reexports");
    const row = results.find((candidate) => candidate.path === "src/events/websocket.rs")!;
    expect(consumersOf(row)).toEqual(["src/client.rs", "src/server.rs"]);
    expect(row.fanInUnresolved).toBe(0);
    expect(unresolved).toEqual({});
  });
});

describe("imports that were not followed", () => {
  test("are counted beside the fan-in of the unit they name", async () => {
    const { results } = await analyse("derived-names");
    const row = results.find((candidate) => candidate.path === "src/errors/build.rs")!;
    expect({ fanIn: row.fanIn, fanInUnresolved: row.fanInUnresolved }).toEqual({ fanIn: 1, fanInUnresolved: 2 });
  });

  test("are listed by reason, the most frequent first, with the name that was not found and the file it was looked for in", async () => {
    const { unresolved, unresolvedSample } = await analyse("derived-names");
    expect(unresolved).toEqual({ "export-not-found": 2 });
    expect(unresolvedSample).toEqual({
      "export-not-found": [{ specifier: "crate::errors::build", name: "UriParseSnafu", to: "src/errors/build.rs", imports: 2, from: "src/http/client.rs", line: 1 }],
    });
  });

  test("are announced in a table run", async () => {
    const run = await runInProcess(cli, repos.get("derived-names")!.path, ["analyse"], true);
    expect(run.code).toBe(ExitCode.Success);
    expect(run.stdout + run.stderr).toContain("Imports not followed to a file or a definition: export-not-found 2");
  });
});
