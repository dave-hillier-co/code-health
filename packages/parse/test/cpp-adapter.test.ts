import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyseTree } from "../src/analyse-tree.ts";
import { adapterById, overrideSupportedAdapters } from "../src/languages.ts";
import { cppBoundaries } from "../src/languages/cpp/boundaries.ts";
import { parseCmake } from "../src/languages/cpp/cmake.ts";
import { treeFromTexts } from "../src/source-tree.ts";

/**
 * What is particular to the C++ adapter beyond the shared conformance fixtures: the preprocessor reporting,
 * include path sources other than the fixture's, externals, test paths and CMake reading.
 */
const cpp = adapterById("cpp")!;

beforeAll(() => overrideSupportedAdapters([cpp]));
afterAll(() => overrideSupportedAdapters(undefined));

const analyse = (texts: Record<string, string>) => analyseTree(treeFromTexts(texts));

describe("macro-generated code, which the grammar cannot see", () => {
  it("is reported for each file, where a macro stands in for a declaration", async () => {
    const tree = treeFromTexts({
      "gen.cpp": ["DECLARE_HANDLER(Foo, Bar);", "REGISTER_TYPE(Baz)", "#define MAKE(x) class x##Impl { void run(); };", "#define LIMIT 4", "int ok() { return LIMIT; }", ""].join("\n"),
      "plain.cpp": "int plain() { return 1; }\n",
    });
    const { GrammarSet } = await import("../src/grammars.ts");
    const { parseWith } = await import("../src/file-facts.ts");
    const grammars = new GrammarSet({ adapters: [cpp] });
    const found: Record<string, unknown> = {};
    for (const path of tree.files.keys()) {
      const language = (await grammars.forPath(path))!;
      found[path] = parseWith(cpp, language.grammar, (await tree.read(path))!).macroGenerated ?? null;
    }
    expect(found).toEqual({
      "gen.cpp": [
        { line: 1, name: "DECLARE_HANDLER", kind: "invocation" },
        { line: 2, name: "REGISTER_TYPE", kind: "invocation" },
        { line: 3, name: "MAKE", kind: "definition" },
      ],
      "plain.cpp": null,
    });
  });

  it("is not reported for a constant macro or a call inside a function", async () => {
    const analysis = await analyse({ "a.cpp": "#define LIMIT 4\nint f() { check(LIMIT); return 0; }\n" });
    expect(analysis.filesWithMacroCode).toEqual([]);
  });

  it("is listed in the analysis by file", async () => {
    const analysis = await analyse({ "gen.cpp": "REGISTER_TYPE(Baz)\nint ok() { return 1; }\n", "plain.cpp": "int plain() { return 1; }\n" });
    expect(analysis.filesWithMacroCode).toEqual(["gen.cpp"]);
  });
});

describe("include paths", () => {
  it("come from compile_commands.json with relative directories and an arguments array", async () => {
    const analysis = await analyse({
      "compile_commands.json": JSON.stringify([{ directory: ".", file: "app/main.cpp", arguments: ["c++", "-I", "libs/core", "-Ilibs/extra", "-c", "app/main.cpp"] }]),
      "app/main.cpp": '#include <core.h>\n#include "extra.h"\nint main() { return 0; }\n',
      "libs/core/core.h": "int core();\n",
      "libs/extra/extra.h": "int extra();\n",
    });
    expect(analysis.importEdges.map((edge) => `${edge.from} -> ${edge.to}`)).toEqual(["app/main.cpp -> libs/core/core.h", "app/main.cpp -> libs/extra/extra.h"]);
  });

  it("fall back to target_include_directories for the files under the CMakeLists.txt that states them", async () => {
    const analysis = await analyse({
      "CMakeLists.txt": "add_library(core src/core.cpp)\ntarget_include_directories(core PUBLIC include PRIVATE src)\n",
      "src/core.cpp": '#include <core/api.h>\n#include "detail.h"\nint core() { return 0; }\n',
      "include/core/api.h": "int api();\n",
      "src/detail.h": "int detail();\n",
    });
    expect(analysis.importEdges.map((edge) => `${edge.from} -> ${edge.to}`)).toEqual(["src/core.cpp -> include/core/api.h", "src/core.cpp -> src/detail.h"]);
  });

  it("do not mistake a system directory for the repository's own include folder", async () => {
    const analysis = await analyse({
      "compile_commands.json": JSON.stringify([{ directory: "/home/dev/proj", file: "/home/dev/proj/main.cpp", command: "c++ -I/usr/include -I/home/dev/proj/inc -c main.cpp" }]),
      "main.cpp": "#include <a.h>\nint main() { return 0; }\n",
      "include/a.h": "int a();\n",
      "inc/b.h": "int b();\n",
    });
    // a.h is under include/, which only /usr/include would name, so it is not found: the root is tried last, and it is not there either.
    expect(analysis.importEdges).toEqual([]);
  });

  it("report quoted includes that are nowhere and angle includes of an outside library", async () => {
    const analysis = await analyse({ "main.cpp": '#include "nowhere.h"\n#include <boost/asio.hpp>\n#include <sys/types.h>\n#include <vector>\nint main() { return 0; }\n' });
    expect(analysis.unresolved).toEqual([{ from: "main.cpp", line: 1, specifier: "nowhere.h", reason: "not-found" }]);
    expect(analysis.externalImports).toEqual([{ from: "main.cpp", packageName: "boost", typeOnly: false }]);
  });
});

describe("header and source pairing", () => {
  it("pairs a source file with the header of its stem in the same folder when it does not include it", async () => {
    const analysis = await analyse({ "a/x.h": "int x();\n", "a/x.cpp": "int x() { return 1; }\n" });
    expect(analysis.importEdges.map((edge) => `${edge.from} -> ${edge.to}`)).toEqual(["a/x.h -> a/x.cpp"]);
  });

  it("pairs a source file with the header of its own folder, not a foreign header of the same stem that sorts first", async () => {
    const analysis = await analyse({
      "core/config.h": "int core();\n",
      "net/config.h": "int net();\n",
      "net/config.cpp": '#include "../core/config.h"\n#include "config.h"\nint net() { return core(); }\n',
    });
    const edges = analysis.importEdges.map((edge) => `${edge.from} -> ${edge.to}`);
    expect(edges).toContain("net/config.h -> net/config.cpp");
    expect(edges).toContain("net/config.cpp -> core/config.h");
    expect(edges).not.toContain("core/config.h -> net/config.cpp");
  });

  it("does not pair files of different stems or folders", async () => {
    const analysis = await analyse({ "a/x.h": "int x();\n", "b/x.cpp": '#include "../a/y.h"\nint x() { return 1; }\n', "a/y.h": "int y();\n" });
    expect(analysis.importEdges.map((edge) => `${edge.from} -> ${edge.to}`)).toEqual(["b/x.cpp -> a/y.h"]);
  });
});

describe("test paths", () => {
  it.each(["tests/a.cpp", "test/a.cpp", "src/unittests/a.cc", "src/money_test.cpp", "src/money_unittest.cc", "src/test_money.cpp", "src/MoneyTest.cpp", "src/money.test.cpp"])("%s is a test", (path) => {
    expect(cpp.isTestPath(path)).toBe(true);
  });

  it.each(["src/money.cpp", "src/latest.cpp", "src/contest.h", "src/attestation.cpp"])("%s is not", (path) => {
    expect(cpp.isTestPath(path)).toBe(false);
  });
});

describe("CMake", () => {
  const text = [
    "cmake_minimum_required(VERSION 3.20)",
    "project(demo VERSION 1.2.0) # a comment",
    "add_library(core STATIC src/a.cpp src/b.cpp)",
    "add_library(demo::core ALIAS core)",
    "target_include_directories(core PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include> PRIVATE src)",
    "target_link_libraries(core PUBLIC fmt::fmt base)",
    "add_executable(tool main.cpp)",
    "add_subdirectory(extras)",
  ].join("\n");

  it("reads targets, their include directories and links, and subdirectories", () => {
    expect(parseCmake(text)).toEqual({
      project: "demo",
      targets: [
        { name: "core", kind: "library", sources: ["src/a.cpp", "src/b.cpp"], publicIncludes: ["include"], privateIncludes: ["src"], links: ["fmt::fmt", "base"] },
        { name: "tool", kind: "executable", sources: ["main.cpp"], publicIncludes: [], privateIncludes: [], links: [] },
      ],
      includeDirectories: [],
      subdirectories: ["extras"],
    });
  });

  it("gives one boundary per CMakeLists.txt, with the public headers as entries and executables private", async () => {
    const tree = treeFromTexts({
      "lib/CMakeLists.txt": "add_library(core a.cpp)\ntarget_include_directories(core PUBLIC include)\n",
      "lib/include/core/a.h": "",
      "lib/src/internal.h": "",
      "app/CMakeLists.txt": "add_executable(app main.cpp)\n",
      "CMakeLists.txt": "project(root)\nadd_subdirectory(lib)\nadd_subdirectory(app)\n",
    });
    expect(await cppBoundaries.discover(tree)).toEqual([
      { dir: ".", manifest: "CMakeLists.txt", name: "root", private: null, entryFiles: [] },
      { dir: "app", manifest: "app/CMakeLists.txt", name: "app", private: true, entryFiles: [] },
      { dir: "lib", manifest: "lib/CMakeLists.txt", name: "core", private: null, entryFiles: ["lib/include/core/a.h"] },
    ]);
  });
});
