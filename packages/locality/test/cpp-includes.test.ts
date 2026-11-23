import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runInProcess } from "@code-health/fixtures/cli-testing";
import { GitFixture, type Change } from "@code-health/fixtures/git-fixture";
import { cli } from "../src/cli.ts";
import { runLocality } from "./support/run.ts";

const add = (path: string, content: string): Change => ({ op: "add", path, content });

/**
 * A CMake-shaped repository: headers under `src/<module>/` included as `"<module>/Name.h"`, with the include
 * directory given by a build function the tool does not read, as a game engine does with its own node macro.
 */
const tree = (config: object, extra: Change[] = []): Change[] => [...base(config).filter((change) => !extra.some((other) => other.path === change.path)), ...extra];

const base = (config: object): Change[] => [
  add("code-health.json", JSON.stringify({ locality: { useHistory: false }, ...config })),
  add("CMakeLists.txt", "cmake_minimum_required(VERSION 3.20)\nproject(app)\nmy_add_node(core)\nmy_add_node(ui)\n"),
  add("src/core/Core.h", "#pragma once\nint core();\n"),
  add("src/core/Core.cpp", '#include "core/Core.h"\nint core() { return 1; }\n'),
  add("src/core/Log.h", "#pragma once\nint logLine();\n"),
  add("src/core/Log.cpp", '#include "core/Log.h"\nint logLine() { return 2; }\n'),
  add("src/ui/Panel.h", '#pragma once\n#include "core/Core.h"\nint panel();\n'),
  add("src/ui/Panel.cpp", '#include "ui/Panel.h"\n#include "core/Log.h"\nint panel() { return core() + logLine(); }\n'),
  add("src/app/Main.cpp", '#include "ui/Panel.h"\nint main() { return panel(); }\n'),
];

const commit = (changes: Change[]) => [{ type: "commit" as const, message: "Add the app", date: "2024-01-01T09:00:00Z", changes }];

describe("a repository whose includes name no build file", () => {
  let repo: GitFixture;
  beforeAll(() => {
    repo = GitFixture.build(commit(tree({})));
  });
  afterAll(() => repo.dispose());

  test("resolves them against directories inferred from where the headers are, and says so without a warning", async () => {
    const run = await runLocality(repo.path, ["analyse", "--json", "--limit", "all"]);
    const output = JSON.parse(run.stdout);
    expect(output.includeResolution).toMatchObject({ compileCommands: null, configuredRoots: [], inferredRoots: ["src"], unresolved: 0, aboveGuideline: false });
    expect(output.unresolved).toEqual({});
    expect(run.stderr).toBe("");
    expect(output.results.every((row: { confidence?: unknown }) => row.confidence === undefined)).toBe(true);
  });
});

describe("a repository whose includes mostly find no file", () => {
  let repo: GitFixture;
  beforeAll(() => {
    // The generated headers are not in the tree, and nothing else gives their directory.
    const generated = ["a", "b", "c", "d", "e", "f", "g", "Core"].map((name) => `#include "generated/${name}.h"`).join("\n");
    repo = GitFixture.build(commit(tree({}, [add("src/app/Main.cpp", '#include "ui/Panel.h"\n#include "core/Cfg.h"\nint main() { return panel() + cfg(); }\n'), add("src/app/Gen.cpp", `${generated}\nint gen() { return 0; }\n`), add("src/core/Cfg.h", `#pragma once\n#include "generated/a.h"\ninline int cfg() { return 0; }\n`)])));
  });
  afterAll(() => repo.dispose());

  test("warns on stderr, names the guideline and the remedy, and still lists every unit", async () => {
    const run = await runLocality(repo.path, ["analyse", "--json", "--limit", "all"]);
    expect(run.stderr).toMatch(/^Warning: \d+ of \d+ includes \(\d+\.\d%\) found no file, above the locality\.unresolvedIncludePercent guideline of 20%/);
    expect(run.stderr).toContain("set includeRoots in code-health.json");
    const output = JSON.parse(run.stdout);
    expect(output.includeResolution).toMatchObject({ aboveGuideline: true, guideline: 20, inferredRoots: ["src"] });
    expect(output.includeResolution.unresolvedShare).toBeGreaterThan(0.2);
    expect(output.results.length).toBe(output.summary.units - output.summary.placed);
  });

  test("marks the units that rest on an include that found no file as low confidence, and no other", async () => {
    const run = await runLocality(repo.path, ["analyse", "--json", "--limit", "all"]);
    const rows = JSON.parse(run.stdout).results as { path: string; confidence?: { level: string; reason: string } }[];
    const low = rows.filter((row) => row.confidence !== undefined).map((row) => row.path);
    expect(rows.find((row) => row.path === "src/core/Cfg.h")?.confidence).toEqual({ level: "low", reason: "1 of its own includes found no file" });
    expect(rows.find((row) => row.path === "src/core/Core.h")?.confidence).toEqual({
      level: "low",
      reason: "1 includes of a file named Core.h found no file, so a consumer may be missing",
    });
    expect(low).not.toContain("src/core/Log.h");
  });

  test("prints a notice after a table", async () => {
    const run = await runInProcess(cli, repo.path, ["analyse", "--limit", "all"], true);
    expect(run.stdout).toMatch(/Notice: \d+ of \d+ includes \(\d+\.\d%\) found no file, above the locality\.unresolvedIncludePercent guideline of 20%/);
  });
});

describe("a repository that sets includeRoots", () => {
  let repo: GitFixture;
  beforeAll(() => {
    repo = GitFixture.build(commit(tree({ includeRoots: ["src"] })));
  });
  afterAll(() => repo.dispose());

  test("uses them and does not infer", async () => {
    const run = await runLocality(repo.path, ["analyse", "--json", "--limit", "all"]);
    expect(JSON.parse(run.stdout).includeResolution).toMatchObject({ configuredRoots: ["src"], inferredRoots: [], unresolved: 0 });
  });
});

describe("a repository with a compile_commands.json in build/ that git ignores", () => {
  let repo: GitFixture;
  beforeAll(() => {
    repo = GitFixture.build(commit(tree({}, [add(".gitignore", "build/\n")])));
    mkdirSync(join(repo.path, "build"));
    writeFileSync(join(repo.path, "build", "compile_commands.json"), JSON.stringify([{ directory: `${repo.path}/build`, file: "../src/app/Main.cpp", arguments: ["c++", `-I${repo.path}/src`, "-c", "../src/app/Main.cpp"] }]));
  });
  afterAll(() => repo.dispose());

  test("reads it and says which file it used and that git does not track it", async () => {
    const run = await runLocality(repo.path, ["analyse", "--json", "--limit", "all"]);
    expect(JSON.parse(run.stdout).includeResolution).toMatchObject({ compileCommands: { paths: ["build/compile_commands.json"], tracked: false }, inferredRoots: [], unresolved: 0 });
  });
});
