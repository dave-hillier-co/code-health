import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { analyseTree, type ProjectAnalysis } from "../src/analyse-tree.ts";
import { treeFromRef } from "../src/source-tree.ts";

let repo: GitFixture;
let analysis: ProjectAnalysis;

beforeAll(async () => {
  repo = GitFixture.build([
    {
      type: "commit",
      message: "initial",
      date: "2024-01-01T00:00:00+00:00",
      changes: [
        { op: "add", path: "src/a.ts", content: "export function a() { return 1; }\nexport interface Shape { sides: number }\nexport const hidden = 2;\n" },
        { op: "add", path: "src/b.ts", content: "export function b() { return 2; }\nexport default function main() {}\n" },
        {
          op: "add",
          path: "src/types.ts",
          content: [
            "export interface Port { open(): void }",
            "export abstract class Base { abstract run(): void }",
            "export class Impl extends Base { run() {} }",
            "export enum Color { Red }",
            "export type Alias = string;",
            "export function make() {}",
            "export const value = 1;",
            "class Local {}",
            "interface Hidden {}",
            "export { Local as Renamed, type Hidden };",
            "",
          ].join("\n"),
        },
        { op: "add", path: "src/inner/c.ts", content: "export function c() {}\nexport function d() {}\n" },
        {
          op: "add",
          path: "src/index.ts",
          content: [
            'export { a, type Shape } from "./a.ts";',
            'export { b as renamed } from "./b.ts";',
            'export * from "./inner/c.ts";',
            "export function own() {}",
            'import { hidden } from "./a.ts";',
            "export { hidden as aliasOfHidden };",
            "",
          ].join("\n"),
        },
        {
          op: "add",
          path: "src/uses.ts",
          content: [
            'import { readFile } from "node:fs";',
            'import React, { useState } from "react";',
            'import type { Config } from "@scope/pkg/sub";',
            'export { z } from "zod";',
            "export const x = () => [readFile, React, useState];",
            "",
          ].join("\n"),
        },
      ],
    },
  ]);
  analysis = await analyseTree(await treeFromRef(repo.path, "HEAD"));
});
afterAll(() => repo.dispose());

describe("exports", () => {
  const exportsOf = (file: string) => analysis.exports.filter((e) => e.file === file).map((e) => `${e.name} -> ${e.defined.file}#${e.defined.symbol ?? e.defined.name}`);

  it("lists what a file defines under the names it exports", () => {
    expect(exportsOf("src/a.ts")).toEqual(["Shape -> src/a.ts#Shape", "a -> src/a.ts#a", "hidden -> src/a.ts#hidden"]);
  });

  it("follows re-exports, renames and star exports to the definition", () => {
    expect(exportsOf("src/index.ts")).toEqual([
      "Shape -> src/a.ts#Shape",
      "a -> src/a.ts#a",
      "aliasOfHidden -> src/a.ts#hidden",
      "c -> src/inner/c.ts#c",
      "d -> src/inner/c.ts#d",
      "own -> src/index.ts#own",
      "renamed -> src/b.ts#b",
    ]);
  });

  it("keeps a default export under the name default", () => {
    expect(exportsOf("src/b.ts")).toContain("default -> src/b.ts#main");
  });

  it("leaves out what resolves outside the tree", () => {
    expect(exportsOf("src/uses.ts")).toEqual(["x -> src/uses.ts#x"]);
  });
});

describe("what an export is declared as", () => {
  const kindsOf = () => Object.fromEntries(analysis.exports.filter((e) => e.file === "src/types.ts").map((e) => [e.name, e.defined.kind]));

  it("tells interfaces, abstract classes, classes, enums, type aliases, functions and variables apart", () => {
    expect(kindsOf()).toMatchObject({
      Port: "interface",
      Base: "abstract-class",
      Impl: "class",
      Color: "enum",
      Alias: "type",
      make: "function",
      value: "variable",
    });
  });

  it("follows a name exported under another name or by a clause to its declaration", () => {
    expect(kindsOf().Renamed).toBe("class");
    expect(kindsOf().Hidden).toBe("interface");
  });

  it("is carried through a re-export to the definition", () => {
    const viaIndex = analysis.exports.find((e) => e.file === "src/index.ts" && e.name === "Shape");
    expect(viaIndex?.defined.kind).toBe("interface");
  });
});

describe("external imports", () => {
  it("names the packages outside the tree that each file imports, subpaths folded into the package", () => {
    expect(analysis.externalImports.filter((e) => e.from === "src/uses.ts")).toEqual([
      { from: "src/uses.ts", packageName: "@scope/pkg", typeOnly: true },
      { from: "src/uses.ts", packageName: "react", typeOnly: false },
      { from: "src/uses.ts", packageName: "zod", typeOnly: false },
    ]);
  });

  it("does not count Node's own modules", () => {
    expect(analysis.externalImports.some((e) => e.packageName.includes("fs"))).toBe(false);
  });
});
