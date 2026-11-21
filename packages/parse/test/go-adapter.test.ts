import { describe, expect, it } from "vitest";
import { analyseTree } from "../src/analyse-tree.ts";
import { adapter } from "../src/languages/go/adapter.ts";
import { directoryToImportPath, externalModuleOf, importPathToDirectory, modulesOf, parseGoMod, parseGoWork } from "../src/languages/go/go-mod.ts";
import { treeFromTexts } from "../src/source-tree.ts";

/**
 * What the Go conformance fixtures do not pin: the corners of name resolution, the imports that reach
 * outside the repository, and how go.mod and go.work are read. Written as small repositories, run through
 * the real analysis.
 */
const analyse = (texts: Record<string, string>) => analyseTree(treeFromTexts({ "go.mod": "module example.com/m\n\ngo 1.22\n", ...texts }), { adapters: [adapter] });
const edges = (analysis: Awaited<ReturnType<typeof analyse>>): string[] => analysis.fileEdges.map((edge) => `${edge.from} -> ${edge.to} ${edge.kind}`);

describe("names in one package", () => {
  it("reach the files of the package that declare them, without any import", async () => {
    const analysis = await analyse({
      "a/a.go": "package a\n\nfunc One() int { return two() }\n",
      "a/b.go": "package a\n\nfunc two() int { return 2 }\n",
    });
    expect(edges(analysis)).toEqual(["a/a.go -> a/b.go call"]);
  });

  it("are hidden by a local declaration of the same name", async () => {
    const analysis = await analyse({
      "a/a.go": "package a\n\nfunc One() int {\n\ttwo := func() int { return 1 }\n\treturn two()\n}\n",
      "a/b.go": "package a\n\nfunc two() int { return 2 }\n",
    });
    expect(edges(analysis)).toEqual([]);
  });

  it("are hidden by a parameter, and by a type parameter", async () => {
    const analysis = await analyse({
      "a/a.go": "package a\n\nfunc One(two int) int { return two }\n\nfunc Map[T any](x T) T { return x }\n",
      "a/b.go": "package a\n\nvar two = 2\n\ntype T struct{}\n",
    });
    expect(edges(analysis)).toEqual([]);
  });

  it("are not reached through the keys of a struct literal", async () => {
    const analysis = await analyse({
      "a/a.go": "package a\n\ntype Config struct{ Name string }\n\nfunc New() Config { return Config{Name: \"x\"} }\n",
      "a/b.go": "package a\n\nconst Name = \"other\"\n",
    });
    expect(edges(analysis)).toEqual([]);
  });

  it("are reached through the keys of a map literal, which are values", async () => {
    const analysis = await analyse({
      "a/a.go": "package a\n\nfunc New() map[string]int { return map[string]int{Key: 1} }\n",
      "a/b.go": "package a\n\nconst Key = \"k\"\n",
    });
    expect(edges(analysis)).toEqual(["a/a.go -> a/b.go reference"]);
  });

  it("reach a method called through its own receiver, and not one called on another value", async () => {
    const analysis = await analyse({
      "a/a.go": "package a\n\ntype S struct{}\n\nfunc (s *S) Run(other *S) {\n\ts.step()\n\tother.skipped()\n}\n",
      "a/b.go": "package a\n\nfunc (s *S) step() {}\n\nfunc (s *S) skipped() {}\n",
    });
    expect(analysis.consumers.filter((consumer) => consumer.kind === "call").map((consumer) => `${consumer.fromUnit} -> ${consumer.toSymbol}`)).toEqual(["S.Run -> S.step"]);
  });

  it("follow every build variant of a declaration, as the constraints are read as written", async () => {
    const analysis = await analyse({
      "a/use.go": "package a\n\nfunc Use() { platform() }\n",
      "a/p_linux.go": "//go:build linux\n\npackage a\n\nfunc platform() {}\n",
      "a/p_windows.go": "//go:build windows\n\npackage a\n\nfunc platform() {}\n",
    });
    expect(edges(analysis)).toEqual(["a/use.go -> a/p_linux.go call", "a/use.go -> a/p_windows.go call"]);
  });
});

describe("imports", () => {
  it("reach the package of the directory, under the name the package clause gives, or the alias", async () => {
    const analysis = await analyse({
      "lib/v2/lib.go": "package library\n\nfunc Go() {}\n",
      "a/a.go": 'package a\n\nimport "example.com/m/lib/v2"\n\nfunc One() { library.Go() }\n',
      "b/b.go": 'package b\n\nimport l "example.com/m/lib/v2"\n\nfunc One() { l.Go() }\n',
      "c/c.go": 'package c\n\nimport "example.com/m/lib/v2"\n\nfunc One() { v2.Go() }\n',
    });
    expect(edges(analysis)).toEqual(["a/a.go -> lib/v2/lib.go call", "b/b.go -> lib/v2/lib.go call"]);
  });

  it("do not reach unexported names of another package", async () => {
    const analysis = await analyse({
      "lib/lib.go": "package lib\n\nfunc hidden() {}\n\nfunc Shown() {}\n",
      "a/a.go": 'package a\n\nimport "example.com/m/lib"\n\nfunc One() {\n\tlib.hidden()\n\tlib.Shown()\n}\n',
    });
    expect(analysis.consumers.map((consumer) => consumer.toSymbol)).toEqual(["Shown"]);
  });

  it("give an external test package its own name, and let it reach the package it tests", async () => {
    const analysis = await analyse({
      "lib/lib.go": "package lib\n\nfunc Shown() {}\n",
      "lib/lib_test.go": 'package lib_test\n\nimport "example.com/m/lib"\n\nfunc TestShown() { lib.Shown() }\n',
    });
    expect(edges(analysis)).toEqual(["lib/lib_test.go -> lib/lib.go test"]);
  });

  it("report packages outside the repository by the module go.mod requires, and leave out the standard library", async () => {
    const analysis = await analyse({
      "go.mod": "module example.com/m\n\ngo 1.22\n\nrequire github.com/spf13/cobra v1.8.0\n",
      "a/a.go": 'package a\n\nimport (\n\t"fmt"\n\t"github.com/spf13/cobra/doc"\n\t"golang.org/x/sync/errgroup"\n)\n\nvar _ = fmt.Sprint\nvar _ = doc.GenMarkdown\nvar _ = errgroup.Group{}\n',
    });
    expect(analysis.externalImports.map((external) => external.packageName)).toEqual(["github.com/spf13/cobra", "golang.org/x/sync"]);
  });

  it("follow a local replace directive to its directory", async () => {
    const analysis = await analyse({
      "go.mod": "module example.com/m\n\ngo 1.22\n\nrequire example.com/shared v0.0.0\n\nreplace example.com/shared => ./third_party/shared\n",
      "third_party/shared/shared.go": "package shared\n\nfunc Share() {}\n",
      "a/a.go": 'package a\n\nimport "example.com/shared"\n\nfunc One() { shared.Share() }\n',
    });
    expect(edges(analysis)).toEqual(["a/a.go -> third_party/shared/shared.go call"]);
  });

  it("make an edge from a blank import to the files of the package that initialise", async () => {
    const analysis = await analyse({
      "drivers/drivers.go": "package drivers\n\nfunc init() {}\n",
      "drivers/other.go": "package drivers\n\nfunc Other() {}\n",
      "a/a.go": 'package a\n\nimport _ "example.com/m/drivers"\n',
    });
    expect(edges(analysis)).toEqual(["a/a.go -> drivers/drivers.go reference"]);
  });

  it("report an import inside a module of the repository that names no package", async () => {
    const analysis = await analyse({ "a/a.go": 'package a\n\nimport "example.com/m/gone"\n' });
    expect(analysis.unresolved).toEqual([{ from: "a/a.go", line: 3, specifier: "example.com/m/gone", reason: "not-found" }]);
  });
});

describe("generated files", () => {
  it("have no units, declarations or references, whatever they hold", async () => {
    const analysis = await analyse({
      "a/gen.go": "// Code generated by tool. DO NOT EDIT.\n\npackage a\n\nfunc Generated() { Hand() }\n",
      "a/hand.go": "package a\n\nfunc Hand() { Generated() }\n",
    });
    expect(analysis.units.map((unit) => unit.id)).toEqual(["a/hand.go#Hand"]);
    expect(edges(analysis)).toEqual([]);
  });

  it("are listed, so a plugin can leave them out of the production files", async () => {
    const analysis = await analyse({
      "a/gen.pb.go": "// Code generated by protoc-gen-go. DO NOT EDIT.\n\npackage a\n\nfunc Generated() {}\n",
      "a/hand.go": "package a\n\nfunc Hand() {}\n",
    });
    expect(analysis.generatedFiles).toEqual(["a/gen.pb.go"]);
  });

  it("are told from the text alone by the adapter", () => {
    expect(adapter.isGeneratedSource?.("// Code generated by tool. DO NOT EDIT.\n\npackage a\n")).toBe(true);
    expect(adapter.isGeneratedSource?.("package a\n\n// Code generated by tool. DO NOT EDIT.\n")).toBe(false);
    expect(adapter.isGeneratedSource?.("package a\n")).toBe(false);
  });

  it("are told by the header exactly, so a comment that only mentions it does not exclude a file", async () => {
    const analysis = await analyse({ "a/a.go": "// This file is not code generated by anything.\n\npackage a\n\nfunc Real() {}\n" });
    expect(analysis.units.map((unit) => unit.id)).toEqual(["a/a.go#Real"]);
  });
});

describe("go.mod and go.work", () => {
  it("reads the module, its requires and what is indirect, and the local replaces", () => {
    const module = parseGoMod(
      "svc/go.mod",
      ['module "example.com/svc"', "", "go 1.22", "", "require (", "\tgithub.com/a/a v1.0.0", "\tgithub.com/b/b v2.0.0 // indirect", ")", "", "require github.com/c/c v0.1.0", "", "replace github.com/a/a => ../a", "replace github.com/b/b => github.com/fork/b v1.0.0"].join("\n"),
    );
    expect(module).toEqual({
      dir: "svc",
      path: "example.com/svc",
      requires: [
        { path: "github.com/a/a", indirect: false },
        { path: "github.com/b/b", indirect: true },
        { path: "github.com/c/c", indirect: false },
      ],
      replaces: [{ from: "github.com/a/a", dir: "a" }],
    });
  });

  it("reads the directories of go.work, in a block or one by one", () => {
    expect(parseGoWork("go.work", "go 1.22\n\nuse (\n\t./app\n\t./lib\n)\nuse ./tools\n")).toEqual(["app", "lib", "tools"]);
  });

  it("maps an import path to the directory of the deepest module that holds it, and a directory back to its import path", () => {
    const modules = modulesOf(
      new Map([
        ["go.mod", "module example.com/root\n"],
        ["tools/go.mod", "module example.com/root/tools\n"],
      ]),
    );
    expect(importPathToDirectory(modules, "example.com/root/pkg/a")?.dir).toBe("pkg/a");
    expect(importPathToDirectory(modules, "example.com/root/tools/gen")?.dir).toBe("tools/gen");
    expect(importPathToDirectory(modules, "example.com/other/x")).toBeUndefined();
    expect(directoryToImportPath(modules, "tools/gen")).toBe("example.com/root/tools/gen");
    expect(directoryToImportPath(modules, "pkg/a")).toBe("example.com/root/pkg/a");
    expect(directoryToImportPath(modules, ".")).toBe("example.com/root");
  });

  it("names the module an outside import belongs to, from go.mod or the conventional root of the path", () => {
    const module = parseGoMod("go.mod", "module m\n\nrequire google.golang.org/grpc v1.0.0\n");
    expect(externalModuleOf(module, "google.golang.org/grpc/codes")).toBe("google.golang.org/grpc");
    expect(externalModuleOf(module, "github.com/x/y/z")).toBe("github.com/x/y");
    expect(externalModuleOf(module, "gopkg.in/yaml.v3")).toBe("gopkg.in/yaml.v3");
  });
});
