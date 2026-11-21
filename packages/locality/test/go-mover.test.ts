import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeWithTool } from "@code-health/fixtures/language-conformance";
import { adapterById, overrideSupportedAdapters } from "@code-health/parse/languages";
import { treeFromTexts } from "@code-health/parse/source-tree";
import { moverLanguages } from "../src/movers/language.ts";
import { performMove } from "../src/move-engine.ts";

/**
 * The Go mover beyond the conformance fixtures: what a move leaves in the files it does not move, the
 * skeleton the verifier compares, and the confirmation by gopls, which runs only where gopls is installed.
 */
beforeAll(() => overrideSupportedAdapters([adapterById("go")!]));
afterAll(() => overrideSupportedAdapters(undefined));

const tree = treeFromTexts({
  "go.mod": "module example.com/m\n\ngo 1.22\n",
  "a/a.go": 'package a\n\nimport "example.com/m/b"\n\nfunc Run() {\n\tb.Do()\n}\n',
  "b/do.go": "package b\n\nfunc Do() {}\n",
  "b/other.go": "package b\n\nfunc Other() {}\n",
});

describe("moving the file that declares what another package used", () => {
  it("makes the use a bare name, and drops the import nothing uses any more", async () => {
    const result = await performMove(tree, [{ from: "b/do.go", to: "a/do.go", role: "unit" }]);
    expect(Object.fromEntries(result.texts)).toEqual({
      "a/a.go": "package a\n\nfunc Run() {\n\tDo()\n}\n",
      "a/do.go": "package a\n\nfunc Do() {}\n",
    });
    expect(result.rewrites).toEqual([{ path: "a/a.go", line: 3, from: "example.com/m/b", to: "" }]);
    expect(result.warnings).toEqual([]);
  });

  it("leaves a file in the package it left alone, and the directory-internal rename of a file a no-op", async () => {
    const result = await performMove(tree, [{ from: "b/other.go", to: "b/renamed.go", role: "unit" }]);
    expect(result.texts.size).toBe(0);
  });
});

describe("the skeleton of a Go file", () => {
  it("blanks the imports and the package name, so only what a move rewrites differs", async () => {
    const backend = await moverLanguages.find((language) => language.id === "go")!.load();
    const before = backend.skeleton("a/a.go", 'package a\n\nimport (\n\t"fmt"\n\t"example.com/m/b"\n)\n\nfunc Run() { fmt.Println(b.Do()) }\n');
    const after = backend.skeleton("c/a.go", 'package c\n\nimport (\n\t"fmt"\n\t"example.com/m/moved/b"\n)\n\nfunc Run() { fmt.Println(b.Do()) }\n');
    expect(after.text).toBe(before.text);
    expect(before.specifiers).toEqual([
      { value: "fmt", line: 4 },
      { value: "example.com/m/b", line: 5 },
    ]);
  });
});

describeWithTool("gopls", "the Go mover confirmed by gopls", () => {
  it("confirms a move whose files still type-check", async () => {
    const result = await performMove(tree, [{ from: "b/do.go", to: "a/do.go", role: "unit" }]);
    expect(result.confirmations).toEqual([{ language: "go", tool: "gopls", status: "confirmed", detail: expect.stringContaining("no problem") }]);
  });
}, { args: ["version"] });
