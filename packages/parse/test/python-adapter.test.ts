import { describe, expect, it } from "vitest";
import { adapter } from "../src/languages/python/adapter.ts";
import { PythonResolver } from "../src/languages/python/resolve-module.ts";
import { GrammarSet } from "../src/grammars.ts";
import { parseWith } from "../src/file-facts.ts";
import { treeFromTexts } from "../src/source-tree.ts";

/** Behaviour of the Python adapter that the shared conformance fixtures do not pin: resolution rules, boundaries and the kinds of exports. */

describe("the Python resolver", () => {
  const paths = [
    "app.py",
    "scripts/tool.py",
    "src/acme/__init__.py",
    "src/acme/core.py",
    "src/acme/sub/__init__.py",
    "src/acme/sub/leaf.py",
    "other/helpers.py",
    "tests/test_core.py",
    "namespace/inner/mod.py",
  ];
  const resolver = new PythonResolver(paths);

  it("finds a module under the import root of the importing file, the repository root, or any other root", () => {
    expect(resolver.resolve("src/acme/core.py", "acme.sub.leaf")).toEqual({ kind: "file", path: "src/acme/sub/leaf.py" });
    expect(resolver.resolve("app.py", "src.acme.core")).toEqual({ kind: "file", path: "src/acme/core.py" });
    expect(resolver.resolve("app.py", "acme.core")).toEqual({ kind: "file", path: "src/acme/core.py" });
    expect(resolver.resolve("scripts/tool.py", "other.helpers")).toEqual({ kind: "file", path: "other/helpers.py" });
  });

  it("resolves a package to its __init__.py and walks through directories that have none", () => {
    expect(resolver.resolve("app.py", "acme")).toEqual({ kind: "file", path: "src/acme/__init__.py" });
    expect(resolver.resolve("app.py", "namespace.inner.mod")).toEqual({ kind: "file", path: "namespace/inner/mod.py" });
  });

  it("resolves relative specifiers from the importing file, one level up per extra dot", () => {
    expect(resolver.resolve("src/acme/core.py", ".sub.leaf")).toEqual({ kind: "file", path: "src/acme/sub/leaf.py" });
    expect(resolver.resolve("src/acme/sub/leaf.py", "..core")).toEqual({ kind: "file", path: "src/acme/core.py" });
    expect(resolver.resolve("src/acme/sub/leaf.py", ".")).toEqual({ kind: "file", path: "src/acme/sub/__init__.py" });
    expect(resolver.resolve("src/acme/sub/leaf.py", "..")).toEqual({ kind: "file", path: "src/acme/__init__.py" });
    expect(resolver.resolve("src/acme/core.py", ".missing")).toEqual({ kind: "not-found" });
  });

  it("tells the standard library, other distributions and a missing module of the repository apart", () => {
    expect(resolver.resolve("app.py", "os.path")).toEqual({ kind: "builtin" });
    expect(resolver.resolve("app.py", "__future__")).toEqual({ kind: "builtin" });
    expect(resolver.resolve("app.py", "numpy.linalg")).toEqual({ kind: "external", packageName: "numpy" });
    expect(resolver.resolve("app.py", "acme.gone")).toEqual({ kind: "not-found" });
  });

  it("lets a module of the repository shadow the standard library, as the interpreter does", () => {
    const shadowed = new PythonResolver(["json.py", "main.py"]);
    expect(shadowed.resolve("main.py", "json")).toEqual({ kind: "file", path: "json.py" });
  });

  it("prefers the importing file's own root when two roots have a module of one name", () => {
    const two = new PythonResolver(["one/pkg/__init__.py", "one/pkg/shared.py", "two/pkg/__init__.py", "two/pkg/shared.py"]);
    expect(two.resolve("one/pkg/__init__.py", "pkg.shared")).toEqual({ kind: "file", path: "one/pkg/shared.py" });
    expect(two.resolve("two/pkg/__init__.py", "pkg.shared")).toEqual({ kind: "file", path: "two/pkg/shared.py" });
  });

  it("offers a submodule of a package, and none for a plain module", () => {
    expect(resolver.submodule("src/acme/__init__.py", "core")).toBe("src/acme/core.py");
    expect(resolver.submodule("src/acme/__init__.py", "sub")).toBe("src/acme/sub/__init__.py");
    expect(resolver.submodule("src/acme/__init__.py", "nothing")).toBeUndefined();
    expect(resolver.submodule("src/acme/core.py", "anything")).toBeUndefined();
  });

  it("names a file as a dotted module from an import root", () => {
    expect(resolver.moduleName("src/acme/sub/leaf.py", "src")).toBe("acme.sub.leaf");
    expect(resolver.moduleName("src/acme/sub/__init__.py", "src")).toBe("acme.sub");
    expect(resolver.moduleName("src/acme/core.py", "other")).toBeUndefined();
  });
});

describe("test paths", () => {
  it.each(["tests/a.py", "test/a.py", "pkg/tests/deep/a.py", "test_core.py", "pkg/core_test.py", "conftest.py", "pkg/conftest.py", "app/tests.py", "tests.py"])("%s is a test", (path) => {
    expect(adapter.isTestPath(path)).toBe(true);
  });
  it.each(["core.py", "pkg/contest.py", "pkg/latest.py", "pkg/testing.py", "pkg/attestation_test_data.txt"])("%s is not", (path) => {
    expect(adapter.isTestPath(path)).toBe(false);
  });
});

describe("distribution boundaries", () => {
  const tree = treeFromTexts({
    "pyproject.toml": '[tool.ruff]\nline-length = 100\n',
    "libs/core/pyproject.toml": '[project]\nname = "acme-core"\n[project.scripts]\nacme = "acme_core.cli:main"\n',
    "libs/core/src/acme_core/__init__.py": "",
    "libs/core/src/acme_core/cli.py": "",
    "libs/core/src/acme_core/_impl/__init__.py": "",
    "libs/core/src/other_core/__init__.py": "",
    "libs/core/src/acme_core/tests/__init__.py": "",
    "libs/tool/pyproject.toml": '[tool.poetry]\nname = "acme-tool"\n[project]\nclassifiers = ["Private :: Do Not Upload"]\n',
    "libs/tool/acme_tool/__init__.py": "",
    "libs/broken/pyproject.toml": "[project\n",
  });

  it("reads the name, privacy and entry files of each pyproject.toml, sorted by manifest", async () => {
    const boundaries = await adapter.boundaries.discover(tree);
    expect(boundaries).toEqual([
      { dir: "libs/broken", manifest: "libs/broken/pyproject.toml", name: null, private: null, entryFiles: [] },
      {
        dir: "libs/core",
        manifest: "libs/core/pyproject.toml",
        name: "acme-core",
        private: null,
        entryFiles: ["libs/core/src/acme_core/__init__.py", "libs/core/src/acme_core/cli.py", "libs/core/src/other_core/__init__.py"],
      },
      { dir: "libs/tool", manifest: "libs/tool/pyproject.toml", name: "acme-tool", private: true, entryFiles: [] },
      { dir: ".", manifest: "pyproject.toml", name: null, private: null, entryFiles: [] },
    ]);
  });

  it("recognises manifests by name", () => {
    expect(adapter.boundaries.isManifest("pyproject.toml")).toBe(true);
    expect(adapter.boundaries.isManifest("libs/core/pyproject.toml")).toBe(true);
    expect(adapter.boundaries.isManifest("libs/core/setup.py")).toBe(false);
  });
});

describe("the facts of a module", () => {
  async function factsOf(source: string) {
    const language = (await new GrammarSet({ adapters: [adapter] }).forPath("m.py"))!;
    return parseWith(language.adapter, language.grammar, source);
  }

  it("tell a Protocol, an ABC, an Enum and a plain class apart in the kinds of its exports", async () => {
    const facts = await factsOf(
      [
        "from abc import ABC, ABCMeta",
        "from enum import Enum",
        "from typing import Protocol, Generic",
        "class A(Protocol[T]): ...",
        "class B(ABC): ...",
        "class C(metaclass=ABCMeta): ...",
        "class D(Enum): ...",
        "class E(Generic[T]): ...",
        "def f(): ...",
        "V = 1",
        "type Alias = int",
        "",
      ].join("\n"),
    );
    expect(facts.exports.map((entry) => [entry.exported, entry.kind ?? null])).toEqual([
      ["ABC", null],
      ["ABCMeta", null],
      ["Enum", null],
      ["Protocol", null],
      ["Generic", null],
      ["A", "interface"],
      ["B", "abstract-class"],
      ["C", "abstract-class"],
      ["D", "enum"],
      ["E", "class"],
      ["f", "function"],
      ["V", "variable"],
      ["Alias", "type"],
    ]);
  });

  it("export what a module defines or imports at its top level, also inside if and try, and not __all__ itself", async () => {
    const facts = await factsOf(["try:", "    import fast as impl", "except ImportError:", "    impl = None", "if True:", "    def late(): ...", "__all__ = ['late']", "def outer():", "    def inner(): ...", ""].join("\n"));
    expect(facts.exports.map((entry) => entry.exported)).toEqual(["impl", "late", "outer"]);
  });

  it("report dynamic imports with a literal specifier, and with none when it is computed", async () => {
    const facts = await factsOf(['import importlib', 'importlib.import_module("a.b")', "importlib.import_module(name)", "__import__('c')", 'importlib.import_module(f"x{1}")', ""].join("\n"));
    expect(facts.imports.filter((entry) => entry.kind === "dynamic").map((entry) => entry.specifier)).toEqual(["a.b", null, "c", null]);
  });

  it("mark imports under TYPE_CHECKING as type-only", async () => {
    const facts = await factsOf(["from typing import TYPE_CHECKING", "from a import real", "if TYPE_CHECKING:", "    from b import only_types", ""].join("\n"));
    expect(facts.imports.map((entry) => [entry.specifier, entry.typeOnly])).toEqual([
      ["typing", false],
      ["a", false],
      ["b", true],
    ]);
  });

  it("do not count a name rebound inside a function as a use of the import of the same name", async () => {
    const facts = await factsOf(["from a import helper, other", "def f(helper):", "    return helper() + other()", "def g():", "    helper = 1", "    return helper", ""].join("\n"));
    expect(facts.references.map((reference) => [reference.local, reference.inUnit])).toEqual([["other", "f"]]);
  });

  it("read a dotted import as the whole dotted name and its uses as members of it", async () => {
    const facts = await factsOf(["import pkg.sub.mod", "def f():", "    return pkg.sub.mod.run() + pkg.sub.mod.value", ""].join("\n"));
    expect(facts.imports[0]!.bindings).toEqual([{ imported: "*", local: "pkg.sub.mod", typeOnly: false }]);
    expect(facts.references.map((reference) => [reference.local, reference.member, reference.kind])).toEqual([
      ["pkg.sub.mod", "run", "call"],
      ["pkg.sub.mod", "value", "reference"],
    ]);
  });
});
