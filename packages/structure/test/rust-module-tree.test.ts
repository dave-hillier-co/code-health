import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { repositoryOfFixture } from "@code-health/fixtures/fixture-repository";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { runStructure } from "./support/run.ts";

/**
 * What a Rust dependency edge is, for cycles: a `mod name;` declaration and a `pub use` that passes a name along
 * are the module tree and its facade, and a `use` depends on the file that defines the item.
 */
const fixtures = ["module-declarations", "glob-reexports", "parent-child-cycle", "reexport-chain"] as const;
const repos = new Map<string, GitFixture>();
beforeAll(() => {
  for (const name of fixtures) repos.set(name, repositoryOfFixture("rust", "adapter", name));
});
afterAll(() => {
  for (const repo of repos.values()) repo.dispose();
});

async function cycles(name: (typeof fixtures)[number], level: string): Promise<{ nodes: string[]; breakingSet: { from: string; to: string }[] }[]> {
  const run = await runStructure(repos.get(name)!.path, ["cycles", "--json", "--level", level]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  return JSON.parse(run.stdout).results;
}

describe("cycles in a Rust crate", () => {
  test("has none between a parent that declares and re-exports its children and the children that import through it", async () => {
    expect(await cycles("module-declarations", "file")).toEqual([]);
  });

  test("has none through a glob re-export: the consumers depend on the file that defines the names", async () => {
    expect(await cycles("glob-reexports", "file")).toEqual([]);
  });

  test("keeps the cycle of a parent that calls its child and a child that uses a type of the parent", async () => {
    const found = await cycles("parent-child-cycle", "file");
    expect(found.map((cycle) => cycle.nodes)).toEqual([["src/registry/builder.rs", "src/registry/mod.rs"]]);
    expect(found[0]!.breakingSet).toHaveLength(1);
  });
});

describe("a crate that only re-exports another", () => {
  const evidence = (pair: string, level: string) => runStructure(repos.get("reexport-chain")!.path, ["evidence", pair, "--json", "--level", level]);

  test("is not what its consumers depend on at file level: they depend on the defining files", async () => {
    const onFacade = await evidence("crates/app/src/main.rs->crates/facade/src/lib.rs", "file");
    expect(onFacade.code).toBe(ExitCode.Usage);
    expect(onFacade.stderr).toContain("no dependency from");
    const onDefinition = await evidence("crates/app/src/main.rs->crates/core/src/transform/sync.rs", "file");
    expect(onDefinition.code).toBe(ExitCode.Success);
    expect(JSON.parse(onDefinition.stdout).results[0].imports.fileEdges).toBe(1);
  });

  test("still depends on the crate it re-exports at package level, and is in no cycle with it", async () => {
    expect(await cycles("reexport-chain", "package")).toEqual([]);
    const run = await evidence("crates/facade->crates/core", "package");
    expect(run.code).toBe(ExitCode.Success);
    expect(JSON.parse(run.stdout).results[0].imports.files).toEqual([
      { from: "crates/facade/src/lib.rs", to: "crates/core/src/config.rs" },
      { from: "crates/facade/src/lib.rs", to: "crates/core/src/lib.rs" },
      { from: "crates/facade/src/lib.rs", to: "crates/core/src/transform/mod.rs" },
    ]);
  });

  test("is the package its consumers import, so reaching the other crate through it is no import past an entry point", async () => {
    const run = await runStructure(repos.get("reexport-chain")!.path, ["packages", "boundaries", "--json"]);
    expect(run.code).toBe(ExitCode.Success);
    expect(JSON.parse(run.stdout).results).toEqual([]);
  });
});
