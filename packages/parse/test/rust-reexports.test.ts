import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyseTree } from "../src/analyse-tree.ts";
import { adapterById, overrideSupportedAdapters } from "../src/languages.ts";
import { treeFromTexts } from "../src/source-tree.ts";

/**
 * Where a Rust path lands when it goes through a re-export, a macro or a module the layout does not show. The
 * fixtures in `fixtures/languages/rust/adapter` pin the common shapes whole. These pin one rule each.
 */
beforeAll(() => overrideSupportedAdapters([adapterById("rust")!]));
afterAll(() => overrideSupportedAdapters(undefined));

const analyse = (files: Record<string, string>) => analyseTree(treeFromTexts(files));
const manifest = '[package]\nname = "app"\n';
type Analysis = Awaited<ReturnType<typeof analyse>>;
const uses = (analysis: Analysis): string[] => analysis.consumers.map((consumer) => `${consumer.from} -> ${consumer.to}#${consumer.toSymbol ?? `:${consumer.toExport}`} ${consumer.kind}`);
const dependencies = (analysis: Analysis): string[] => analysis.importEdges.filter((edge) => edge.nominal !== true).map((edge) => `${edge.from} -> ${edge.to}${edge.test === true ? " test" : ""}`);
const unresolved = (analysis: Analysis): string[] => analysis.unresolved.map((entry) => `${entry.from} ${entry.specifier} ${entry.name ?? ""} ${entry.reason}`);

describe("a path through a re-exported module", () => {
  it("goes on in the module's file, also when the module is an inline one of another file", async () => {
    const analysis = await analyse({
      "Cargo.toml": manifest,
      "src/lib.rs": "mod codec;\nmod reader;\npub use codec::fields;\n",
      "src/codec.rs": "pub mod fields {\n    pub const LEVEL: u8 = 1;\n}\n",
      "src/reader.rs": "use crate::fields::LEVEL;\npub fn level() -> u8 { LEVEL }\n",
    });
    expect(unresolved(analysis)).toEqual([]);
    expect(dependencies(analysis)).toEqual(["src/reader.rs -> src/codec.rs"]);
  });

  it("ends without an unresolved import when the module is re-exported from outside the tree", async () => {
    const analysis = await analyse({
      "Cargo.toml": manifest,
      "src/lib.rs": "mod reader;\npub use vrl::path;\n",
      "src/reader.rs": "use crate::path::parse_target_path;\npub fn read() { parse_target_path(\"a\"); }\n",
    });
    expect(unresolved(analysis)).toEqual([]);
    expect(dependencies(analysis)).toEqual([]);
  });

  it("follows a crate bound whole by `use name as alias`", async () => {
    const analysis = await analyse({
      "Cargo.toml": '[workspace]\nmembers = ["a", "b", "c"]\n',
      "a/Cargo.toml": '[package]\nname = "a"\n\n[dependencies]\nb = { path = "../b" }\n',
      "a/src/lib.rs": "use b::settings::Limits;\npub fn f(limits: &Limits) {}\n",
      "b/Cargo.toml": '[package]\nname = "b"\n\n[dependencies]\nc = { path = "../c" }\n',
      "b/src/lib.rs": "pub use c as settings;\n",
      "c/Cargo.toml": '[package]\nname = "c"\n',
      "c/src/lib.rs": "pub struct Limits;\n",
    });
    expect(uses(analysis)).toEqual(["a/src/lib.rs -> c/src/lib.rs#Limits reference"]);
    expect(analysis.importEdges.find((edge) => edge.from === "a/src/lib.rs")).toEqual({ from: "a/src/lib.rs", to: "c/src/lib.rs", kind: "import", typeOnly: false, via: "b/src/lib.rs" });
  });

  it("starts at what another `use` of the file binds, when the path's first name is that binding", async () => {
    const analysis = await analyse({
      "Cargo.toml": manifest,
      "src/lib.rs": "pub mod config;\npub mod graph;\n",
      "src/config/mod.rs": "pub mod component;\n",
      "src/config/component.rs": "pub struct Component;\n",
      "src/graph.rs": "use crate::config::component;\nuse component::Component;\npub fn node(component: &Component) {}\n",
    });
    expect(unresolved(analysis)).toEqual([]);
    expect(uses(analysis)).toEqual(["src/graph.rs -> src/config/component.rs#Component reference"]);
  });
});

describe("a name that several re-exports could hold", () => {
  it("is the one a glob lists, before a glob whose file invokes a macro that may define names", async () => {
    const analysis = await analyse({
      "Cargo.toml": manifest,
      "src/lib.rs": "pub mod events;\nmod user;\n",
      "src/events/mod.rs": "mod filter;\nmod socket;\npub(crate) use self::filter::*;\npub(crate) use self::socket::*;\n",
      "src/events/filter.rs": "registered_event!(Dropped);\n",
      "src/events/socket.rs": "pub struct Connected;\n",
      "src/user.rs": "use crate::events::Connected;\npub fn f() -> Connected { Connected }\n",
    });
    expect(dependencies(analysis)).toEqual(["src/user.rs -> src/events/socket.rs"]);
  });

  it("is taken to be defined by the file a macro stands for items in, when nothing lists it", async () => {
    const analysis = await analyse({
      "Cargo.toml": manifest,
      "src/lib.rs": "pub mod proto;\nmod user;\n",
      "src/proto.rs": 'pub mod v1 {\n    tonic::include_proto!("events.v1");\n}\n',
      "src/user.rs": "use crate::proto::v1::Event;\npub fn f(event: &Event) {}\n",
    });
    expect(unresolved(analysis)).toEqual([]);
    expect(uses(analysis)).toEqual(["src/user.rs -> src/proto.rs#:Event reference"]);
  });

  it("is a file's own item, whatever a test module inside the file imports under the same name", async () => {
    const analysis = await analyse({
      "Cargo.toml": manifest,
      "src/lib.rs": "mod batcher;\nmod user;\npub use batcher::Settings;\n",
      "src/batcher.rs": "pub struct Settings;\n\n#[cfg(test)]\nmod tests {\n    use crate::Settings;\n    fn check(settings: Settings) {}\n}\n",
      "src/user.rs": "use crate::Settings;\npub fn f(settings: &Settings) {}\n",
    });
    expect(unresolved(analysis)).toEqual([]);
    expect(uses(analysis)).toContain("src/user.rs -> src/batcher.rs#Settings reference");
  });
});

describe("names a macro gives a crate", () => {
  it("resolve a derive macro by the name in `proc_macro_derive`, through the crate that re-exports it", async () => {
    const analysis = await analyse({
      "Cargo.toml": '[workspace]\nmembers = ["app", "common", "macros"]\n',
      "app/Cargo.toml": '[package]\nname = "app"\n\n[dependencies]\ncommon = { path = "../common" }\n',
      "app/src/lib.rs": "use common::NamedEvent;\n\n#[derive(NamedEvent)]\npub struct Started;\n",
      "common/Cargo.toml": '[package]\nname = "common"\n\n[dependencies]\nmacros = { path = "../macros" }\n',
      "common/src/lib.rs": "pub use macros::NamedEvent;\n",
      "macros/Cargo.toml": '[package]\nname = "macros"\n\n[lib]\nproc-macro = true\n',
      "macros/src/lib.rs": "#[proc_macro_derive(NamedEvent)]\npub fn derive_named_event(input: TokenStream) -> TokenStream {\n    input\n}\n",
    });
    expect(unresolved(analysis)).toEqual([]);
    expect(uses(analysis)).toEqual(["app/src/lib.rs -> macros/src/lib.rs#derive_named_event reference"]);
  });

  it("leave a bare macro of no crate of the tree alone", async () => {
    const analysis = await analyse({ "Cargo.toml": manifest, "src/lib.rs": 'pub fn f() {\n    info!("started");\n    println!("x");\n}\n' });
    expect(unresolved(analysis)).toEqual([]);
    expect(analysis.importEdges).toEqual([]);
  });
});

describe("the module tree where the layout does not show it", () => {
  it("takes `super` of a module declared with #[path] to be the file that declares it", async () => {
    const analysis = await analyse({
      "Cargo.toml": manifest,
      "src/lib.rs": "mod docs;\n",
      "src/docs/mod.rs": "mod schema;\n",
      "src/docs/schema.rs": '#[path = "schema_core.rs"]\nmod core;\npub struct Context;\n',
      "src/docs/schema_core.rs": "use super::Context;\npub fn read(context: &Context) {}\n",
    });
    expect(unresolved(analysis)).toEqual([]);
    expect(uses(analysis)).toEqual(["src/docs/schema_core.rs -> src/docs/schema.rs#Context reference"]);
  });

  it("keeps the files beside a binary target declared inside the library's tree as modules of the library", async () => {
    const analysis = await analyse({
      "Cargo.toml": '[package]\nname = "app"\n\n[[bin]]\nname = "example"\npath = "src/loading/example.rs"\n',
      "src/lib.rs": "pub mod loading;\npub struct Config;\n",
      "src/loading/mod.rs": "mod loader;\npub struct Format;\n",
      "src/loading/loader.rs": "use super::Format;\nuse crate::Config;\npub fn load(format: &Format, config: &Config) {}\n",
      "src/loading/example.rs": "fn main() {}\n",
    });
    expect(unresolved(analysis)).toEqual([]);
    expect(uses(analysis)).toEqual(["src/loading/loader.rs -> src/lib.rs#Config reference", "src/loading/loader.rs -> src/loading/mod.rs#Format reference"]);
  });

  it("reads `crate::name` in a binary as the library, when `name` is the crate and not a module of the binary", async () => {
    const analysis = await analyse({
      "Cargo.toml": manifest,
      "src/lib.rs": "pub mod telemetry;\n",
      "src/telemetry.rs": "pub const INTERVAL: u64 = 5;\n",
      "src/main.rs": "extern crate app;\nfn main() {\n    let _interval = crate::app::telemetry::INTERVAL;\n}\n",
    });
    expect(unresolved(analysis)).toEqual([]);
    expect(dependencies(analysis)).toEqual(["src/main.rs -> src/telemetry.rs"]);
  });

  it("finds a module whose name is a raw identifier", async () => {
    const analysis = await analyse({ "Cargo.toml": manifest, "src/lib.rs": "mod r#ref;\n", "src/ref.rs": "pub struct Ref;\n" });
    expect(unresolved(analysis)).toEqual([]);
  });
});

describe("what makes a dependency of one file on another", () => {
  it("a path written out from `crate`, `self` or `super` in code is one, like a `use` of the same path", async () => {
    const analysis = await analyse({
      "Cargo.toml": manifest,
      "src/lib.rs": "pub mod builder;\npub mod loading;\n",
      "src/builder.rs": "pub fn build() {\n    super::loading::warn();\n    crate::loading::Level::High;\n}\n",
      "src/loading.rs": "pub fn warn() {}\npub enum Level { High }\n",
    });
    expect(uses(analysis)).toEqual(["src/builder.rs -> src/loading.rs#Level reference", "src/builder.rs -> src/loading.rs#warn call"]);
  });

  it("a struct literal is a use of the struct", async () => {
    const analysis = await analyse({
      "Cargo.toml": manifest,
      "src/lib.rs": "pub mod point;\npub mod origin;\n",
      "src/point.rs": "pub struct Point { pub x: i32 }\n",
      "src/origin.rs": "use crate::point::Point;\npub fn origin() -> i32 {\n    let point = Point { x: 0 };\n    point.x\n}\n",
    });
    expect(analysis.consumers.map((consumer) => `${consumer.toSymbol} x${consumer.count}`)).toEqual(["Point x1"]);
  });

  it("a trait imported for its methods is one, though no code names it again", async () => {
    const analysis = await analyse({
      "Cargo.toml": manifest,
      "src/lib.rs": "pub mod render;\npub mod shape;\n",
      "src/shape.rs": "pub trait Area {\n    fn area(&self) -> f64;\n}\n",
      "src/render.rs": "use crate::shape::Area;\npub fn draw(shape: &impl Sized) {}\n",
    });
    expect(uses(analysis)).toEqual(["src/render.rs -> src/shape.rs#Area reference"]);
  });

  it("a private glob through which no use is found is still an import of its module, and one a use is found through is not", async () => {
    const analysis = await analyse({
      "Cargo.toml": manifest,
      "src/lib.rs": "pub mod prelude;\npub mod shapes;\npub mod silent;\npub mod user;\n",
      "src/prelude.rs": "pub use crate::shapes::Circle;\n",
      "src/shapes.rs": "pub struct Circle;\n",
      "src/silent.rs": "use crate::prelude::*;\npub fn f() {}\n",
      "src/user.rs": "use crate::prelude::*;\npub fn f(circle: &Circle) {}\n",
    });
    expect(dependencies(analysis)).toEqual(["src/silent.rs -> src/prelude.rs", "src/user.rs -> src/shapes.rs"]);
  });

  it("a re-export that only the file's own test code also uses is not one for its production code", async () => {
    const analysis = await analyse({
      "Cargo.toml": manifest,
      "src/lib.rs": "mod diff;\npub use diff::Diff;\n\n#[cfg(test)]\nmod tests {\n    use super::Diff;\n    fn check(diff: Diff) {}\n}\n",
      "src/diff.rs": "pub struct Diff;\n",
    });
    expect(dependencies(analysis)).toEqual(["src/lib.rs -> src/diff.rs test"]);
  });

  it("does not loop on re-exports that name each other", async () => {
    const analysis = await analyse({
      "Cargo.toml": manifest,
      "src/lib.rs": "pub mod a;\npub mod b;\nmod user;\n",
      "src/a.rs": "pub use crate::b::*;\npub use crate::b::Missing;\n",
      "src/b.rs": "pub use crate::a::*;\npub use crate::a::Missing;\n",
      "src/user.rs": "use crate::a::Missing;\nuse crate::b::Other;\n",
    });
    expect(unresolved(analysis).filter((entry) => entry.startsWith("src/user.rs"))).toEqual(["src/user.rs crate::a Missing export-not-found", "src/user.rs crate::b Other export-not-found"]);
  });
});
