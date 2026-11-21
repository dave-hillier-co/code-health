import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyseTree } from "../src/analyse-tree.ts";
import { adapterById, overrideSupportedAdapters } from "../src/languages.ts";
import { treeFromTexts } from "../src/source-tree.ts";

/**
 * Rust behaviour the shared conformance fixtures do not pin: what is public, how modules are found when the
 * layout is not the plain one, and how the paths of `use` are counted from inline modules.
 */
beforeAll(() => overrideSupportedAdapters([adapterById("rust")!]));
afterAll(() => overrideSupportedAdapters(undefined));

const analyse = (files: Record<string, string>) => analyseTree(treeFromTexts(files));

describe("what a crate exposes", () => {
  const files = {
    "src/lib.rs": "mod inner;\npub use inner::Thing;\npub use inner::Hidden;\n",
    "src/inner.rs": "pub struct Thing;\npub(crate) struct Hidden;\nstruct Private;\npub fn open() {}\nfn closed() {}\n",
  };

  it("lists only plain `pub` names as exports, and follows them to where they are defined", async () => {
    const { exports } = await analyse(files);
    expect(exports.map((entry) => `${entry.file} ${entry.name} -> ${entry.defined.file}#${entry.defined.name} ${entry.defined.kind}`)).toEqual([
      "src/inner.rs Thing -> src/inner.rs#Thing class",
      "src/inner.rs open -> src/inner.rs#open function",
      "src/lib.rs Thing -> src/inner.rs#Thing class",
    ]);
  });

  it("marks a unit exported only when it is plain `pub`", async () => {
    const { units } = await analyse(files);
    expect(units.map((unit) => `${unit.qualifiedName} ${unit.exported}`)).toEqual(["Thing true", "Hidden false", "Private false", "open true", "closed false"]);
  });

  it("still resolves a private item a child module uses", async () => {
    const analysis = await analyse({
      "src/lib.rs": "mod parser;\nstruct Context;\n",
      "src/parser.rs": "use super::Context;\n\npub fn parse(c: &Context) {}\n",
    });
    expect(analysis.unresolved).toEqual([]);
    expect(analysis.consumers.map((consumer) => `${consumer.from}#${consumer.fromUnit} -> ${consumer.to}#${consumer.toSymbol}`)).toEqual(["src/parser.rs#parse -> src/lib.rs#Context"]);
  });
});

describe("the module tree", () => {
  it("finds a module as `name.rs` or `name/mod.rs`, and the children of `name.rs` under `name/`", async () => {
    const analysis = await analyse({
      "src/lib.rs": "mod flat;\nmod nested;\n",
      "src/flat.rs": "mod child;\n",
      "src/flat/child.rs": "pub fn f() {}\n",
      "src/nested/mod.rs": "mod leaf;\n",
      "src/nested/leaf.rs": "pub fn g() {}\n",
    });
    expect(analysis.unresolved).toEqual([]);
    expect(analysis.importEdges.map((edge) => `${edge.from} -> ${edge.to}`)).toEqual([
      "src/flat.rs -> src/flat/child.rs",
      "src/lib.rs -> src/flat.rs",
      "src/lib.rs -> src/nested/mod.rs",
      "src/nested/mod.rs -> src/nested/leaf.rs",
    ]);
  });

  it("follows #[path] and modules declared inside inline modules", async () => {
    const analysis = await analyse({
      "src/lib.rs": '#[path = "elsewhere/odd.rs"]\nmod odd;\nmod outer {\n    mod inside;\n}\n',
      "src/elsewhere/odd.rs": "pub fn f() {}\n",
      "src/outer/inside.rs": "pub fn g() {}\n",
    });
    expect(analysis.unresolved).toEqual([]);
    expect(analysis.importEdges.map((edge) => `${edge.from} -> ${edge.to}`)).toEqual(["src/lib.rs -> src/elsewhere/odd.rs", "src/lib.rs -> src/outer/inside.rs"]);
  });

  it("counts `super` and `self` from an inline module's own place", async () => {
    const analysis = await analyse({
      "src/lib.rs": "mod util;\nmod tests {\n    use super::util::helper;\n    use self::nested::deep;\n    mod nested {\n        pub fn deep() {}\n    }\n    fn run() { helper(); deep(); }\n}\n",
      "src/util.rs": "pub fn helper() {}\n",
    });
    expect(analysis.unresolved).toEqual([]);
    expect(analysis.consumers.map((consumer) => `${consumer.fromUnit} -> ${consumer.to}#${consumer.toSymbol}`)).toEqual(["tests.run -> src/util.rs#helper"]);
  });

  it("leaves a use of the file's own module alone, so `use super::*` in a test module adds no edge to itself", async () => {
    const analysis = await analyse({ "src/lib.rs": "pub fn f() {}\n#[cfg(test)]\nmod tests {\n    use super::*;\n    use super::f;\n}\n" });
    expect(analysis.importEdges).toEqual([]);
    expect(analysis.fileEdges).toEqual([]);
  });

  it("reads the crates a path dependency and a workspace dependency name", async () => {
    const analysis = await analyse({
      "Cargo.toml": '[workspace]\nmembers = ["a", "b"]\n\n[workspace.dependencies]\nb = { path = "b" }\n',
      "a/Cargo.toml": '[package]\nname = "a"\n\n[dependencies]\nb = { workspace = true }\n',
      "a/src/lib.rs": "use b::Thing;\npub fn f(_: Thing) {}\n",
      "b/Cargo.toml": '[package]\nname = "b"\n',
      "b/src/lib.rs": "pub struct Thing;\n",
    });
    expect(analysis.fileEdges.map((edge) => `${edge.from} -> ${edge.to}`)).toEqual(["a/src/lib.rs -> b/src/lib.rs"]);
  });

  it("reports a crate that is not in the tree as external, and std as neither", async () => {
    const analysis = await analyse({ "src/lib.rs": "use std::fmt;\nuse serde::Serialize;\nuse regex_lite::Regex;\n" });
    expect(analysis.externalImports.map((external) => external.packageName)).toEqual(["regex_lite", "serde"]);
    expect(analysis.unresolved).toEqual([]);
  });

  it("imports the enum, not the variant, when a path ends in one", async () => {
    const analysis = await analyse({
      "src/lib.rs": "mod shape;\nuse shape::Kind::Round;\nfn f() { let _ = Round; }\n",
      "src/shape.rs": "pub enum Kind { Round }\n",
    });
    expect(analysis.unresolved).toEqual([]);
    expect(analysis.consumers.map((consumer) => `${consumer.to}#${consumer.toSymbol}`)).toEqual(["src/shape.rs#Kind"]);
  });
});

describe("crates named in code", () => {
  it("count as imports when a path starts with a name the file neither declares nor imports", async () => {
    const analysis = await analyse({
      "src/lib.rs": 'mod util;\nuse util::helper;\npub fn f() -> String {\n    log::info!("x");\n    util::other();\n    u32::MAX;\n    serde_json::to_string(&helper()).unwrap()\n}\n',
      "src/util.rs": "pub fn helper() {}\npub fn other() {}\n",
    });
    expect(analysis.externalImports.map((external) => external.packageName)).toEqual(["log", "serde_json"]);
    expect(analysis.unresolved).toEqual([]);
  });

  it("reach a workspace crate through the path, down to the item", async () => {
    const analysis = await analyse({
      "a/Cargo.toml": '[package]\nname = "a"\n\n[dependencies]\nb = { path = "../b" }\n',
      "a/src/lib.rs": "pub fn f() { b::store::Store::open(); }\n",
      "b/Cargo.toml": '[package]\nname = "b"\n',
      "b/src/lib.rs": "pub mod store;\n",
      "b/src/store.rs": "pub struct Store;\nimpl Store { pub fn open() {} }\n",
    });
    expect(analysis.consumers.map((consumer) => `${consumer.from}#${consumer.fromUnit} -> ${consumer.to}#${consumer.toSymbol}`)).toEqual(["a/src/lib.rs#f -> b/src/store.rs#Store"]);
  });
});

describe("names in macros", () => {
  it("count as uses, with the member of a path", async () => {
    const analysis = await analyse({
      "src/lib.rs": "mod util;\nuse util::helper;\nfn f() { println!(\"{}\", helper(1)); assert_eq!(util::helper(2), 3); }\n",
      "src/util.rs": "pub fn helper(x: i32) -> i32 { x }\n",
    });
    expect(analysis.consumers.map((consumer) => `${consumer.fromUnit} -> ${consumer.to}#${consumer.toSymbol} x${consumer.count}`)).toEqual(["f -> src/util.rs#helper x2"]);
  });
});
