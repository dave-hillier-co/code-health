import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyseTree } from "../src/analyse-tree.ts";
import { parseFacts } from "../src/file-facts.ts";
import { loadGrammar } from "../src/grammars.ts";
import { adapterById, overrideSupportedAdapters } from "../src/languages.ts";
import { treeFromTexts } from "../src/source-tree.ts";

/** Code under `#[cfg(test)]` in a file that is not a test by its path is test code: its units, its lines, its imports and its uses. */
beforeAll(() => overrideSupportedAdapters([adapterById("rust")!]));
afterAll(() => overrideSupportedAdapters(undefined));

const analyse = (files: Record<string, string>) => analyseTree(treeFromTexts(files));
const facts = async (source: string) => parseFacts("src/lib.rs", await loadGrammar("rust"), source);
const edges = (analysis: Awaited<ReturnType<typeof analyse>>) => ({
  imports: analysis.importEdges.map((edge) => `${edge.from} -> ${edge.to}${edge.test === true ? " test" : ""}${edge.nominal === true ? " nominal" : ""}`),
  files: analysis.fileEdges.map((edge) => `${edge.from} -> ${edge.to} ${edge.kind}`),
  consumers: analysis.consumers.map((consumer) => `${consumer.fromUnit} -> ${consumer.toSymbol} ${consumer.kind}`),
});

describe("which cfg predicates make test code", () => {
  it.each([
    ["test", true],
    ["all(test, feature = \"api\")", true],
    ["all(unix, any(test, doc))", false],
    ["all(unix, all(test, not(windows)))", true],
    ["any(test, feature = \"test-utils\")", false],
    ["any(test, all(test, unix))", true],
    ["not(test)", false],
    ["feature = \"test\"", false],
  ])("cfg(%s) is test code: %s", async (predicate, test) => {
    const { units } = await facts(`#[cfg(${predicate})]\nmod tests {\n    fn helper() {}\n}\n`);
    expect(units.map((unit) => `${unit.qualifiedName} ${unit.test === true}`)).toEqual([`tests.helper ${test}`]);
  });

  it("marks every item under a test attribute, not only functions", async () => {
    const { units } = await facts("#[cfg(test)]\nstruct Fixture;\n#[cfg(test)]\nimpl Fixture {\n    fn build() {}\n}\n#[cfg(test)]\nfn helper() {}\npub fn run() {}\n");
    expect(units.map((unit) => `${unit.qualifiedName} ${unit.test === true}`)).toEqual(["Fixture true", "Fixture.build true", "helper true", "run false"]);
  });
});

describe("the lines of test code", () => {
  it("are the ranges of the outermost test items, from their first attribute", async () => {
    const source = [
      "pub fn run() {}",
      "",
      "/// Checks.",
      "#[cfg(test)]",
      "#[allow(dead_code)]",
      "mod tests {",
      "    #[test]",
      "    fn works() {}",
      "}",
      "",
      "#[test]",
      "fn outside() {}",
      "",
    ].join("\n");
    expect((await facts(source)).testRanges).toEqual([
      { startLine: 4, endLine: 9 },
      { startLine: 11, endLine: 12 },
    ]);
  });

  it("are absent from a file with no test code", async () => {
    expect((await facts("pub fn run() {}\n")).testRanges).toBeUndefined();
  });
});

describe("imports and uses in test code", () => {
  it("make a test edge when only test code uses the other file", async () => {
    const analysis = await analyse({
      "src/lib.rs": "mod util;\npub fn run() {}\n#[cfg(test)]\nmod tests {\n    use crate::util::helper;\n    fn check() { helper(); }\n}\n",
      "src/util.rs": "pub fn helper() {}\n",
    });
    expect(edges(analysis)).toEqual({
      imports: ["src/lib.rs -> src/util.rs test", "src/lib.rs -> src/util.rs nominal"],
      files: ["src/lib.rs -> src/util.rs test"],
      consumers: ["tests.check -> helper test"],
    });
  });

  it("mark the import edge as test code when every statement behind it is", async () => {
    const analysis = await analyse({
      "src/lib.rs": "pub mod util;\nmod other;\npub fn run() {}\n",
      "src/util.rs": "pub fn helper() {}\n",
      "src/other.rs": "#[cfg(test)]\nuse crate::util::helper;\n#[cfg(test)]\nmod tests {\n    use crate::util;\n    fn check() { super::helper(); util::helper(); }\n}\n",
    });
    expect(edges(analysis).imports).toContain("src/other.rs -> src/util.rs test");
  });

  it("keep a production edge when production code also uses the file", async () => {
    const analysis = await analyse({
      "src/lib.rs": "mod util;\nuse util::helper;\npub fn run() { helper(); }\n#[cfg(test)]\nmod tests {\n    use crate::util::helper;\n    fn check() { helper(); }\n}\n",
      "src/util.rs": "pub fn helper() {}\n",
    });
    expect(edges(analysis)).toEqual({
      imports: ["src/lib.rs -> src/util.rs", "src/lib.rs -> src/util.rs nominal"],
      files: ["src/lib.rs -> src/util.rs call"],
      consumers: ["run -> helper call", "tests.check -> helper test"],
    });
  });

  it("make the declaration of a test module a test edge", async () => {
    const analysis = await analyse({ "src/lib.rs": "pub fn run() {}\n#[cfg(test)]\nmod tests;\n", "src/tests.rs": "use super::run;\nfn check() { run(); }\n" });
    expect(edges(analysis).imports).toContain("src/lib.rs -> src/tests.rs test nominal");
  });

  it("make a crate named inline in test code a test import", async () => {
    const { imports } = await facts("pub fn run() { serde_json::to_string(&1); }\n#[cfg(test)]\nmod tests {\n    fn check() { tempfile::tempdir(); }\n}\n");
    expect(imports.map((imported) => `${imported.specifier} ${imported.test === true}`)).toEqual(["serde_json false", "tempfile true"]);
  });
});
