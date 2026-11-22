import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyseTree } from "../src/analyse-tree.ts";
import { readBuildConfigs } from "../src/build-configs.ts";
import { describeIncludeResolution, lowConfidenceReader } from "../src/include-resolution.ts";
import { inferIncludeRoots } from "../src/languages/cpp/include-paths.ts";
import { adapterById, overrideSupportedAdapters } from "../src/languages.ts";
import { treeFromTexts } from "../src/source-tree.ts";

/**
 * How C++ includes are resolved when the tree's own build files say nothing: a build directory's compile_commands.json
 * that git does not track, the `includeRoots` setting, directories inferred from where the included files are, and what
 * is reported about how many includes still found no file. The shapes follow a CMake project whose headers sit under
 * `src/<module>/` and are included as `"<module>/Name.h"`.
 */
const cpp = adapterById("cpp")!;

beforeAll(() => overrideSupportedAdapters([cpp]));
afterAll(() => overrideSupportedAdapters(undefined));

const project = {
  "src/stage/Terrain.h": "#pragma once\n#include \"base/Result.h\"\nint terrain();\n",
  "src/stage/Terrain.cpp": '#include "stage/Terrain.h"\nint terrain() { return 1; }\n',
  "src/base/Result.h": "#pragma once\nint result();\n",
  "src/base/Result.cpp": '#include "base/Result.h"\nint result() { return 2; }\n',
  "src/app/Main.cpp": '#include "stage/Terrain.h"\n#include "base/Result.h"\nint main() { return terrain() + result(); }\n',
  "tests/stage/TerrainTest.cpp": '#include "stage/Terrain.h"\nint check() { return terrain(); }\n',
};

const analyse = (texts: Record<string, string>, options: Parameters<typeof analyseTree>[1] = {}) => analyseTree(treeFromTexts(texts), options);
const edges = (analysis: Awaited<ReturnType<typeof analyse>>) => analysis.importEdges.filter((edge) => edge.pairing !== true).map((edge) => `${edge.from} -> ${edge.to}`);

describe("without a compile_commands.json or an includeRoots setting", () => {
  it("infers the directory the includes are written against from where the included files are", async () => {
    const analysis = await analyse(project);
    expect(analysis.includeResolution).toMatchObject({ compileCommands: null, configuredRoots: [], inferredRoots: ["src"], unresolved: 0, unresolvedShare: 0 });
    expect(analysis.unresolved).toEqual([]);
    expect(edges(analysis)).toContain("src/app/Main.cpp -> src/stage/Terrain.h");
    expect(edges(analysis)).toContain("tests/stage/TerrainTest.cpp -> src/stage/Terrain.h");
  });

  it("infers every directory that resolves includes no other does, shallower ones first on a tie", async () => {
    expect(
      inferIncludeRoots(
        [{ specifier: "stage/A.h" }, { specifier: "stage/B.h" }, { specifier: "util/U.h" }, { specifier: "util/V.h" }],
        ["src/stage/A.h", "src/stage/B.h", "libs/util/U.h", "libs/util/V.h", "other/stage/A.h"],
      ),
    ).toEqual(["libs", "src"]);
  });

  it("does not take a directory that resolves a single include, which is more likely a shared name than a root", () => {
    expect(inferIncludeRoots([{ specifier: "stage/A.h" }], ["src/stage/A.h"])).toEqual([]);
  });

  it("reports the share that still found no file, and lists those includes as unresolved", async () => {
    const analysis = await analyse({ ...project, "src/app/Broken.cpp": '#include "vendor/Missing.h"\nint broken() { return 0; }\n' });
    expect(analysis.unresolved.map((entry) => `${entry.from}: ${entry.specifier}`)).toEqual(["src/app/Broken.cpp: vendor/Missing.h"]);
    expect(analysis.includeResolution).toMatchObject({ includes: 7, unresolved: 1, unresolvedShare: 0.1429 });
  });
});

describe("with includeRoots", () => {
  it("tries the roots and reports them, and does not infer", async () => {
    const analysis = await analyse(project, { includeRoots: ["src/", "./"] });
    expect(analysis.includeResolution).toMatchObject({ configuredRoots: ["src", ""], inferredRoots: [], unresolved: 0 });
    expect(edges(analysis)).toContain("src/app/Main.cpp -> src/base/Result.h");
  });

  it("leaves includes unresolved that the roots do not reach, however well another directory would do", async () => {
    const analysis = await analyse(project, { includeRoots: ["libs"] });
    expect(analysis.includeResolution?.inferredRoots).toEqual([]);
    expect(analysis.includeResolution?.unresolved).toBe(6);
  });
});

describe("with a compile_commands.json", () => {
  const commands = JSON.stringify([{ directory: "/home/dev/app/build", file: "../src/app/Main.cpp", arguments: ["c++", "-I/home/dev/app/src", "-c", "../src/app/Main.cpp"] }]);

  it("reads one the tree tracks, and says so", async () => {
    const analysis = await analyse({ ...project, "compile_commands.json": commands });
    expect(analysis.includeResolution).toMatchObject({ compileCommands: { paths: ["compile_commands.json"], tracked: true }, inferredRoots: [], unresolved: 0 });
  });

  it("reads one given from disk, says it is not tracked, and does not infer", async () => {
    const analysis = await analyse(project, { extraConfigs: new Map([["build/compile_commands.json", commands]]) });
    expect(analysis.includeResolution).toMatchObject({ compileCommands: { paths: ["build/compile_commands.json"], tracked: false }, inferredRoots: [], unresolved: 0 });
  });

  it("prefers a tracked one, and ignores the one from disk", async () => {
    const tracked = JSON.stringify([{ directory: ".", file: "src/app/Main.cpp", arguments: ["c++", "-Isrc", "-c", "src/app/Main.cpp"] }]);
    const analysis = await analyse({ ...project, "compile_commands.json": tracked }, { extraConfigs: new Map([["build/compile_commands.json", commands]]) });
    expect(analysis.includeResolution?.compileCommands).toEqual({ paths: ["compile_commands.json"], tracked: true });
  });
});

describe("a header and its source file", () => {
  it("are joined by an edge marked as pairing, which stands for the pair being one unit and is no include", async () => {
    const analysis = await analyse(project);
    const pairing = analysis.importEdges.filter((edge) => edge.pairing === true).map((edge) => `${edge.from} -> ${edge.to}`);
    expect(pairing).toEqual(["src/base/Result.h -> src/base/Result.cpp", "src/stage/Terrain.h -> src/stage/Terrain.cpp"]);
    expect(analysis.importEdges.filter((edge) => edge.from === "src/stage/Terrain.cpp" && edge.to === "src/stage/Terrain.h")).toEqual([]);
  });
});

describe("the report of how includes resolved", () => {
  const resolution = { compileCommands: null, configuredRoots: [], inferredRoots: [], includes: 200, unresolved: 90, unresolvedShare: 0.45 };

  it("gives a notice and a warning above the guideline, naming what was used and what to do", () => {
    const report = describeIncludeResolution(resolution, 20, "structure");
    expect(report.section).toMatchObject({ aboveGuideline: true, guideline: 20, unresolved: 90 });
    expect(report.notice).toContain("90 of 200 includes (45.0%) found no file, above the structure.unresolvedIncludePercent guideline of 20%");
    expect(report.notice).toContain("no compile_commands.json and no includeRoots setting, and no include directory could be inferred");
    expect(report.warning).toMatch(/^Warning: /);
    expect(report.warning).toContain("set includeRoots in code-health.json");
  });

  it("gives neither within the guideline, and still reports the share", () => {
    const report = describeIncludeResolution({ ...resolution, unresolved: 10, unresolvedShare: 0.05 }, 20, "structure");
    expect(report.notice).toBeUndefined();
    expect(report.warning).toBeUndefined();
    expect(report.section).toMatchObject({ aboveGuideline: false, unresolvedShare: 0.05 });
  });

  it("names the compile_commands.json that was used, and that git does not track it", () => {
    const report = describeIncludeResolution({ ...resolution, compileCommands: { paths: ["build/compile_commands.json"], tracked: false } }, 20, "locality");
    expect(report.notice).toContain("include directories from build/compile_commands.json (not tracked by git)");
  });
});

describe("low confidence", () => {
  const unresolved = [
    { from: "src/app/Main.cpp", line: 3, specifier: "vendor/Missing.h", reason: "not-found" as const },
    { from: "src/app/Other.cpp", line: 1, specifier: "stage/Terrain.h", reason: "not-found" as const },
    { from: "app.ts", line: 1, specifier: "./stage/Terrain", reason: "not-found" as const },
  ];
  const reasonOf = lowConfidenceReader(unresolved);

  it("marks a file with an include of its own that found no file", () => {
    expect(reasonOf("src/app/Main.cpp")).toBe("1 of its own includes found no file");
  });

  it("marks a file that an include elsewhere names and found no file, because a consumer may be missing", () => {
    expect(reasonOf("src/stage/Terrain.h")).toBe("1 includes of a file named Terrain.h found no file, so a consumer may be missing");
  });

  it("leaves other files, and files of other languages, unmarked", () => {
    expect(reasonOf("src/base/Result.h")).toBeUndefined();
    expect(reasonOf("app.ts")).toBeUndefined();
  });
});

describe("the build directories that are read from disk", () => {
  const root = mkdtempSync(join(tmpdir(), "code-health-build-configs-"));
  const entry = (file: string) => JSON.stringify([{ directory: root, file, command: `c++ -c ${file}` }]);
  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("finds nothing when no build directory holds one", () => {
    expect([...readBuildConfigs(root, treeFromTexts({}))]).toEqual([]);
  });

  it("reads one in build/, whether git tracks it or not", () => {
    write("build/compile_commands.json", entry("a.cpp"));
    expect([...readBuildConfigs(root, treeFromTexts({})).keys()]).toEqual(["build/compile_commands.json"]);
  });

  it("prefers the repository root, then build/, then out/, then cmake-build-*", () => {
    write("out/compile_commands.json", entry("b.cpp"));
    write("cmake-build-debug/compile_commands.json", entry("c.cpp"));
    expect([...readBuildConfigs(root, treeFromTexts({})).keys()]).toEqual(["build/compile_commands.json"]);
    write("compile_commands.json", entry("d.cpp"));
    expect([...readBuildConfigs(root, treeFromTexts({})).keys()]).toEqual(["compile_commands.json"]);
  });

  it("reads one below build/ or out/build/, as a per-preset build directory is laid out", () => {
    const presets = mkdtempSync(join(tmpdir(), "code-health-presets-"));
    mkdirSync(join(presets, "out", "build", "linux-debug"), { recursive: true });
    writeFileSync(join(presets, "out", "build", "linux-debug", "compile_commands.json"), entry("e.cpp"));
    expect([...readBuildConfigs(presets, treeFromTexts({})).keys()]).toEqual(["out/build/linux-debug/compile_commands.json"]);
    rmSync(presets, { recursive: true, force: true });
  });

  it("skips a file that is not a JSON array with an entry", () => {
    const broken = mkdtempSync(join(tmpdir(), "code-health-broken-"));
    mkdirSync(join(broken, "build"), { recursive: true });
    writeFileSync(join(broken, "build", "compile_commands.json"), "[]");
    writeFileSync(join(broken, "compile_commands.json"), "not json");
    expect([...readBuildConfigs(broken, treeFromTexts({}))]).toEqual([]);
    rmSync(broken, { recursive: true, force: true });
  });

  it("reads nothing when the tree tracks a compile_commands.json, which is read from the tree", () => {
    expect([...readBuildConfigs(root, treeFromTexts({ "tools/compile_commands.json": "[]" }))]).toEqual([]);
  });
});
