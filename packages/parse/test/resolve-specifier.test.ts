import { describe, expect, it } from "vitest";
import { parseJsonc } from "../src/jsonc.ts";
import { SpecifierResolver } from "../src/resolve-specifier.ts";

const resolver = (files: string[], configs: Record<string, string> = {}) =>
  new SpecifierResolver(files, new Map(Object.entries(configs)));

describe("builtins", () => {
  it("prefers a local module named like a builtin when baseUrl, paths or a workspace resolve it", () => {
    const baseUrl = resolver(["src/a.ts", "src/util/x.ts"], { "tsconfig.json": '{"compilerOptions":{"baseUrl":"src"}}' });
    expect(baseUrl.resolve("src/a.ts", "util/x")).toEqual({ kind: "file", path: "src/util/x.ts" });

    const paths = resolver(["src/a.ts", "src/constants/x.ts"], {
      "tsconfig.json": '{"compilerOptions":{"paths":{"constants/*":["./src/constants/*"]}}}',
    });
    expect(paths.resolve("src/a.ts", "constants/x")).toEqual({ kind: "file", path: "src/constants/x.ts" });

    const workspace = resolver(["a.ts", "pkg/events/index.ts"], { "pkg/events/package.json": '{"name":"events"}' });
    expect(workspace.resolve("a.ts", "events")).toEqual({ kind: "file", path: "pkg/events/index.ts" });
  });

  it("still classifies real builtins and the node: prefix", () => {
    const r = resolver(["a.ts"]);
    expect(r.resolve("a.ts", "fs")).toEqual({ kind: "builtin" });
    expect(r.resolve("a.ts", "fs/promises")).toEqual({ kind: "builtin" });
    expect(r.resolve("a.ts", "node:test")).toEqual({ kind: "builtin" });
  });
});

describe("tsconfig references", () => {
  it("follows a solution config to the referenced config that includes the file", () => {
    const r = resolver(["src/a.ts", "src/x.ts"], {
      "tsconfig.json": '{"files":[],"references":[{"path":"./tsconfig.app.json"},{"path":"./tsconfig.node.json"}]}',
      "tsconfig.app.json": '{"compilerOptions":{"paths":{"@/*":["./src/*"]}},"include":["src"]}',
      "tsconfig.node.json": '{"include":["vite.config.ts"]}',
    });
    expect(r.resolve("src/a.ts", "@/x")).toEqual({ kind: "file", path: "src/x.ts" });
  });
});

describe("jsonc", () => {
  it("ignores a leading byte order mark", () => {
    expect(parseJsonc('﻿{"a":1}')).toEqual({ a: 1 });
    const r = resolver(["a.ts", "src/x.ts"], { "tsconfig.json": '﻿{"compilerOptions":{"baseUrl":"src"}}' });
    expect(r.resolve("a.ts", "x")).toEqual({ kind: "file", path: "src/x.ts" });
  });
});

describe("package exports", () => {
  it("substitutes every star in the target", () => {
    const r = resolver(["a.ts", "p/a/a.js"], { "p/package.json": '{"name":"p","exports":{"./*":"./*/*.js"}}' });
    expect(r.resolve("a.ts", "p/a")).toEqual({ kind: "file", path: "p/a/a.js" });
  });

  it("prefers import over require whatever the key order", () => {
    const r = resolver(["a.ts", "p/cjs.js", "p/esm.mjs"], {
      "p/package.json": '{"name":"p","exports":{".":{"require":"./cjs.js","import":"./esm.mjs"}}}',
    });
    expect(r.resolve("a.ts", "p")).toEqual({ kind: "file", path: "p/esm.mjs" });
  });

  it("falls back to src when the export points at an uncommitted build directory", () => {
    const r = resolver(["a.ts", "p/src/index.ts"], { "p/package.json": '{"name":"p","exports":{".":"./dist/index.js"}}' });
    expect(r.resolve("a.ts", "p")).toEqual({ kind: "file", path: "p/src/index.ts" });
  });
});
