import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeWithTool } from "@code-health/fixtures/language-conformance";
import { adapterById, overrideSupportedAdapters } from "@code-health/parse/languages";
import { treeFromTexts } from "@code-health/parse/source-tree";
import { performMove } from "../src/move-engine.ts";
import { moverLanguages } from "../src/movers/language.ts";

/**
 * What is particular to moving C++ files beyond the shared move fixtures: the skeleton that verification
 * compares, and clangd's confirmation, which runs only where clangd is installed.
 */
beforeAll(() => overrideSupportedAdapters([adapterById("cpp")!]));
afterAll(() => overrideSupportedAdapters(undefined));

const cppMover = moverLanguages.find((language) => language.id === "cpp")!;

const tree = treeFromTexts({
  "CMakeLists.txt": "add_executable(app src/main.cpp)\ntarget_include_directories(app PRIVATE include)\n",
  "include/core/api.h": "#pragma once\nint api();\n",
  "src/main.cpp": '#include <core/api.h>\n\nint main() { return api(); }\n',
});

describe("the C++ skeleton", () => {
  it("blanks the include paths and lists them, so a respelled include is told from another change", async () => {
    const backend = await cppMover.load();
    const skeleton = backend.skeleton("a.cpp", '#include "x/y.h"\n#include <z.h>\n#include MACRO\nint a() { return 1; }\n');
    expect(skeleton.text).toBe('#include ""\n#include <>\n#include MACRO\nint a() { return 1; }\n');
    expect(skeleton.specifiers).toEqual([
      { value: "x/y.h", line: 1 },
      { value: "<z.h>", line: 2 },
    ]);
  });
});

describe("confirmation by clangd", () => {
  it("is reported not confirmed, and is no failure, when clangd is not installed", async () => {
    const empty = mkdtempSync(join(tmpdir(), "code-health-empty-"));
    try {
      const result = await performMove(tree, [{ from: "include/core/api.h", to: "include/core/v2/api.h", role: "unit" }], { searchPath: empty });
      expect(result.confirmations).toEqual([
        { language: "cpp", tool: "clangd", status: "not confirmed", detail: "clangd (clangd) is not installed, so references were not confirmed" },
      ]);
      expect(result.texts.get("src/main.cpp")).toBe('#include <core/v2/api.h>\n\nint main() { return api(); }\n');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  describeWithTool("clangd", "the C++ move", () => {
    it("confirms a move whose references all still resolve", async () => {
      const result = await performMove(tree, [{ from: "include/core/api.h", to: "include/core/v2/api.h", role: "unit" }]);
      expect(result.confirmations.map((entry) => [entry.tool, entry.status])).toEqual([["clangd", "confirmed"]]);
    });

    it("reports a reference that does not resolve after the move", async () => {
      const broken = treeFromTexts({
        "CMakeLists.txt": "add_executable(app src/main.cpp)\n",
        "src/main.cpp": '#include "gone.h"\n\nint main() { return 0; }\n',
      });
      const result = await performMove(broken, [{ from: "src/main.cpp", to: "src/app/main.cpp", role: "unit" }]);
      expect(result.confirmations).toHaveLength(1);
      expect(result.confirmations[0]!.status).toBe("not confirmed");
      expect(result.confirmations[0]!.detail).toContain("src/app/main.cpp:1");
      expect(result.confirmations[0]!.detail).toContain("gone.h");
    });
  });
});
