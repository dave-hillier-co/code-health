import type { Node } from "web-tree-sitter";
import type { FileFacts, SymbolDeclaration, SymbolReference, UnitFact } from "../../src/facts.ts";
import type { LanguageAdapter } from "../../src/language-adapter.ts";
import { typescriptMetricRules } from "../../src/languages/typescript/metric-rules.ts";

/**
 * A made-up symbol-based language, so the contract and the symbol model can be tested without a real
 * second language. One statement per line:
 *
 *   namespace Acme.Core      the file declares into a namespace
 *   using Acme.Core          the file brings a namespace into scope
 *   class Money              a declaration that is a unit (`public class` is exported)
 *   call Money               inside the last class: a call of a name
 *   ref Money                inside the last class: a reference to a name
 *
 * The text is parsed with the TypeScript grammar only because an adapter needs one; the extractor reads
 * the text of the root.
 */
function extract(root: Node): FileFacts {
  const namespaces: string[] = [];
  const uses: string[] = [];
  const declarations: SymbolDeclaration[] = [];
  const references: SymbolReference[] = [];
  const units: UnitFact[] = [];
  const lines = root.text.split("\n");
  lines.forEach((raw, index) => {
    const line = raw.trim();
    const [word, name] = line.split(/\s+/, 2) as [string, string | undefined];
    const exported = word === "public";
    const [keyword, declared] = exported ? (line.split(/\s+/).slice(1) as [string, string]) : [word, name];
    if (keyword === "namespace" && declared) namespaces.push(declared);
    else if (keyword === "using" && declared) uses.push(declared);
    else if (keyword === "class" && declared) {
      const qualified = namespaces.length > 0 ? `${namespaces[0]}.${declared}` : declared;
      units.push({ qualifiedName: declared, kind: "class", startLine: index + 1, endLine: index + 1, source: "structural" });
      declarations.push({ name: qualified, kind: "class", unit: declared, exported, line: index + 1 });
    } else if ((keyword === "call" || keyword === "ref") && declared) {
      const inUnit = units.at(-1)?.qualifiedName;
      references.push({ name: declared, kind: keyword === "call" ? "call" : "reference", line: index + 1, ...(inUnit === undefined ? {} : { inUnit }) });
    }
  });
  return { units, imports: [], reexports: [], exports: [], references: [], symbols: { namespaces, uses, declarations, references }, nodes: 0, hasSyntaxErrors: false };
}

/** A toy adapter on `extension`. Adapters built with the same `group` are resolved together. */
export function toyAdapter(id: string, extension: string, options: { group?: string; support?: LanguageAdapter["support"] } = {}): LanguageAdapter {
  return {
    id,
    name: id,
    tier: 2,
    support: options.support ?? "experimental",
    lexerProfile: "typescript",
    grammars: [{ spec: { id: "typescript", packageName: "tree-sitter-typescript", file: "tree-sitter-typescript.wasm" }, extensions: [extension] }],
    extractorVersion: 1,
    extract,
    isTestPath: (path) => path.includes(".test."),
    metrics: typescriptMetricRules,
    dependencies: { model: "symbol-based", isConfigPath: () => false, ...(options.group === undefined ? {} : { group: options.group }) },
    boundaries: { isManifest: () => false, discover: async () => [] },
    census: { extract: () => ({ imports: [], types: [], classes: [], functions: [], calls: [], news: [], decorators: [], keyedMaps: [] }) },
    packaging: { ecosystems: [], description: "toy code" },
    abstractTypes: { typeKinds: ["class"], abstractKinds: [] },
    mover: { kind: "agent", sourceExtensions: [extension], confirmation: null },
  };
}
