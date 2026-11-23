import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyseTree } from "../src/analyse-tree.ts";
import { adapterById, overrideSupportedAdapters } from "../src/languages.ts";
import { treeFromTexts } from "../src/source-tree.ts";

/**
 * A C++ symbol with internal linkage belongs to its own translation unit, so another file that writes the same
 * name never refers to it: static functions and variables, anything in an anonymous namespace, and namespace-scope
 * const or constexpr variables that are neither extern nor inline. In a header they are still a dependency, because
 * every file that includes the header gets its own copy.
 */
const cpp = adapterById("cpp")!;

beforeAll(() => overrideSupportedAdapters([cpp]));
afterAll(() => overrideSupportedAdapters(undefined));

const edges = async (texts: Record<string, string>) => {
  const analysis = await analyseTree(treeFromTexts(texts));
  return analysis.importEdges.filter((edge) => edge.pairing !== true).map((edge) => `${edge.from} -> ${edge.to}`);
};

/** `Entry.cpp` implements `Entry.h`, so a file that includes the header can see the source file too. `Spec.cpp` does. */
const sharing = (entry: string, spec: string, use: string) => ({
  "Entry.h": "#pragma once\nint entry();\n",
  "Entry.cpp": `#include "Entry.h"\n${entry}\nint entry() { return ${use}; }\n`,
  "Spec.cpp": `#include "Entry.h"\n${spec}\nint spec() { return ${use} + entry(); }\n`,
});

describe("C++ symbols with internal linkage", () => {
  it("does not link two files that each define a constexpr of the same name at namespace scope", async () => {
    const result = await edges(sharing("constexpr int kMostDrag = 3;", "constexpr int kMostDrag = 5;", "kMostDrag"));
    expect(result).not.toContain("Spec.cpp -> Entry.cpp");
    expect(result).toContain("Spec.cpp -> Entry.h");
  });

  it("does not link two files that each define a static function of the same name", async () => {
    const result = await edges(sharing("static int eventAge() { return 1; }", "static int eventAge() { return 2; }", "eventAge()"));
    expect(result).not.toContain("Spec.cpp -> Entry.cpp");
  });

  it("does not link two files that each define the same name in an anonymous namespace", async () => {
    const result = await edges(sharing("namespace { int parentContact() { return 1; } }", "namespace { int parentContact() { return 2; } }", "parentContact()"));
    expect(result).not.toContain("Spec.cpp -> Entry.cpp");
  });

  it("does not link two files that each define a static variable or a plain const of the same name", async () => {
    const result = await edges(sharing("static int bornInWindow = 1;\nconst int kModules = 4;", "static int bornInWindow = 2;\nconst int kModules = 5;", "bornInWindow + kModules"));
    expect(result).not.toContain("Spec.cpp -> Entry.cpp");
  });

  it("does not link a file to a static function of a source file that it can see", async () => {
    const result = await edges({
      "A.h": "#pragma once\nint a();\n",
      "A.cpp": '#include "A.h"\nstatic int helper() { return 1; }\nint a() { return helper(); }\n',
      "B.cpp": '#include "A.h"\nint b() { return helper(); }\n',
    });
    expect(result).not.toContain("B.cpp -> A.cpp");
  });

  it("still links to a const declared extern, or an inline constexpr, in a header", async () => {
    const result = await edges({
      "Limits.h": "#pragma once\nextern const int kLimit;\ninline constexpr int kScale = 2;\n",
      "Limits.cpp": '#include "Limits.h"\nconst int kLimit = 9;\n',
      "User.cpp": '#include "Limits.h"\nint user() { return kLimit + kScale; }\n',
    });
    expect(result).toContain("User.cpp -> Limits.h");
  });

  it("still links to a constant that a header defines, which every includer has its own copy of", async () => {
    const result = await edges({
      "Consts.h": "#pragma once\nconstexpr int kWidth = 4;\n",
      "User.cpp": '#include "Consts.h"\nint user() { return kWidth; }\n',
    });
    const analysis = await analyseTree(treeFromTexts({ "Consts.h": "#pragma once\nconstexpr int kWidth = 4;\n", "User.cpp": '#include "Consts.h"\nint user() { return kWidth; }\n' }));
    expect(result).toContain("User.cpp -> Consts.h");
    expect(analysis.consumers.some((consumer) => consumer.from === "User.cpp" && consumer.to === "Consts.h" && consumer.toExport === "kWidth")).toBe(true);
  });

  it("still links a call to a function declared in a header and defined in a source file", async () => {
    const analysis = await analyseTree(
      treeFromTexts({
        "Api.h": "#pragma once\nint compute(int x);\n",
        "Api.cpp": '#include "Api.h"\nint compute(int x) { return x + 1; }\n',
        "Caller.cpp": '#include "Api.h"\nint caller() { return compute(2); }\n',
      }),
    );
    expect(analysis.consumers.some((consumer) => consumer.from === "Caller.cpp" && consumer.toExport === "compute" && consumer.kind === "call")).toBe(true);
    expect(analysis.importEdges.map((edge) => `${edge.from} -> ${edge.to}`)).toContain("Caller.cpp -> Api.h");
  });
});
