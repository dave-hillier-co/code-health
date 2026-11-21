import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadGrammar } from "../src/grammars.ts";

async function parse(source: string) {
  const tree = (await loadGrammar("typescript")).parse(source);
  const result = { hasError: tree.rootNode.hasError, text: tree.rootNode.text };
  tree.delete();
  return result;
}

describe("the TypeScript grammar's repairs of valid files", () => {
  it.each([
    "type A = [specifier: string, symbol: string][];",
    "let abstract = 0;\nabstract++;\nabstract += 2;\nabstract.toFixed();",
    "type A = [a: string, new: boolean];\nlet abstract = 0;\nabstract--;",
  ])("parse without errors: %s", async (source) => {
    expect((await parse(source)).hasError).toBe(false);
  });

  it("keep every position and leave strings and comments as written", async () => {
    const source = 'let abstract = 0;\nabstract++;\nconst s = "symbol: abstract++";\n// abstract++\n';
    const { hasError, text } = await parse(source);
    expect(hasError).toBe(false);
    expect(text.length).toBe(source.length);
    expect(text).toContain('"symbol: abstract++"');
    expect(text).toContain("// abstract++");
  });

  it("still report a real syntax error next to a repairable one", async () => {
    expect((await parse("let abstract = 0;\nabstract++;\nfunction broken(: number {}\n")).hasError).toBe(true);
  });

  it.each([
    "packages/structure/src/packaging/abstractness.ts",
    "packages/structure/test/packaging/support/scenarios.ts",
    "packages/structure/test/support/layer-scenarios.ts",
    "packages/structure/test/support/scenarios.ts",
  ])("parses this repository's %s", async (path) => {
    expect((await parse(readFileSync(path, "utf8"))).hasError).toBe(false);
  });
});
