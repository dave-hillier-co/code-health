import { describe, expect, it } from "vitest";
import { discoverBoundaries } from "../src/languages.ts";
import { treeFromTexts } from "../src/source-tree.ts";

describe("the entry files of a package", () => {
  const tree = treeFromTexts({
    "package.json": JSON.stringify({
      name: "lib",
      main: "./dist/main.js",
      exports: { ".": "./dist/main.js", "./features/*": "./dist/features/*.js", "./internal/*": null },
    }),
    "dist/main.js": "",
    "dist/features/a.js": "",
    "dist/features/deep/b.js": "",
    "dist/features/readme.md": "",
    "dist/hidden/c.js": "",
    "private/package.json": JSON.stringify({ name: "app", private: true, exports: { "./*": "./src/*.ts" } }),
    "private/src/x.ts": "",
  });

  it("include the files a wildcard in the exports map matches, and only those", async () => {
    const boundaries = await discoverBoundaries(tree);
    expect(boundaries.find((boundary) => boundary.manifest === "package.json")?.entryFiles).toEqual([
      "dist/features/a.js",
      "dist/features/deep/b.js",
      "dist/main.js",
    ]);
  });

  it("are empty for a private package, wildcard or not", async () => {
    const boundaries = await discoverBoundaries(tree);
    expect(boundaries.find((boundary) => boundary.manifest === "private/package.json")?.entryFiles).toEqual([]);
  });
});
