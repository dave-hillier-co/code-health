import { describe, expect, it } from "vitest";
import { analyseTree } from "../src/analyse-tree.ts";
import type { SourceTree } from "../src/source-tree.ts";

function treeOf(contents: Record<string, string>): SourceTree {
  const paths = Object.keys(contents).sort();
  return {
    files: new Map(paths.map((path) => [path, `sha-${path}-${contents[path]!.length}`])),
    read: async (path) => contents[path],
    readMany: async (wanted) => new Map(wanted.filter((path) => path in contents).map((path) => [path, contents[path]!])),
  };
}

describe("ambient exports", () => {
  for (const [label, declaration, name] of [
    ["const", "export declare const d: number;", "d"],
    ["function", "export declare function df(): void;", "df"],
    ["namespace", "export declare namespace DN { const x: number }", "DN"],
    ["import alias", "namespace N { export const v = 1 }\nexport import X = N;", "X"],
  ] as const) {
    it(`resolves an import of an exported ambient ${label}`, async () => {
      const analysis = await analyseTree(
        treeOf({ "t.ts": declaration, "u.ts": `import { ${name} } from "./t";\n${name};\n` }),
      );
      expect(analysis.unresolved).toEqual([]);
      expect(analysis.fileEdges.map((edge) => [edge.from, edge.to])).toEqual([["u.ts", "t.ts"]]);
    });
  }
});
