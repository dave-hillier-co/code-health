import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyseTree } from "../src/analyse-tree.ts";
import { adapterById, overrideSupportedAdapters } from "../src/languages.ts";
import { treeFromTexts } from "../src/source-tree.ts";

/** Valid Rust the grammar rejects, which the adapter repairs before reading a file, and where an unrepaired error is reported. */
beforeAll(() => overrideSupportedAdapters([adapterById("rust")!]));
afterAll(() => overrideSupportedAdapters(undefined));

const analyse = (source: string, path = "src/lib.rs") => analyseTree(treeFromTexts({ [path]: source }));

describe("constructs the grammar rejects", () => {
  it.each([
    ["a borrow of a variable named raw", "fn split(raw: &str) -> usize {\n    let head = &raw[1..];\n    count(&raw) + head.len()\n}\n"],
    ["a raw borrow, which stays as it is", "fn pointer(y: u8) {\n    let p = &raw const y;\n    let q = &raw mut y;\n}\n"],
    ["several attributes on one parameter", 'fn roundtrip(\n    #[files("tests/*.avro")]\n    #[exclude(".*fixed.avro")]\n    path: PathBuf,\n    #[case] again: bool,\n) {}\n'],
    ["an attribute on a field of a struct pattern", 'fn from(config: Config) -> u8 {\n    let Config {\n        global,\n        #[cfg(feature = "api")]\n        api,\n        schema,\n    } = config;\n    0\n}\n'],
    ["a higher-ranked bound after a `+` in an impl type", "fn setup() -> (u8, impl Subscriber + for<'a> LookupSpan<'a>) {\n    todo!()\n}\n"],
    ["a turbofish on a function named like a primitive", "fn parse(input: &str) {\n    if let Ok((rest, _)) = char::<_, Error>('#')(input) {\n        run(rest);\n    }\n}\n"],
  ])("parses %s without syntax errors", async (_, source) => {
    const analysis = await analyse(source);
    expect(analysis.filesWithSyntaxErrors).toEqual([]);
    expect(analysis.syntaxErrors).toEqual([]);
  });

  it("keeps the function's metrics after a repair", async () => {
    const analysis = await analyse("fn split(raw: &str) -> usize {\n    if raw.is_empty() {\n        return 0;\n    }\n    count(&raw)\n}\n");
    expect(analysis.units.map((unit) => `${unit.qualifiedName} ${unit.metrics?.cyclomatic} ${unit.startLine}-${unit.endLine}`)).toEqual(["split 2 1-6"]);
  });
});

describe("a file the grammar cannot read", () => {
  it("reports the line and column of its first error, and the text found there", async () => {
    const analysis = await analyse("pub fn fine() {}\n\nfn broken() {\n    let x = 1 @ 2;\n}\n");
    expect(analysis.filesWithSyntaxErrors).toEqual(["src/lib.rs"]);
    expect(analysis.syntaxErrors).toEqual([{ path: "src/lib.rs", line: 4, column: 15, kind: "unexpected", text: "@ 2" }]);
  });

  it("reports a missing token by its kind", async () => {
    const analysis = await analyse("fn f() {\n    let x = 1\n    let y = 2;\n}\n");
    expect(analysis.syntaxErrors).toEqual([{ path: "src/lib.rs", line: 2, column: 14, kind: "missing", text: ";" }]);
  });
});
