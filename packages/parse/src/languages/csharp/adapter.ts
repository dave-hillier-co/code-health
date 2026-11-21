import type { LanguageAdapter } from "../../language-adapter.ts";
import { csharpBoundaries } from "./boundaries.ts";
import { extractFileCensus } from "./census.ts";
import { extractFacts, extractorVersion } from "./extract-facts.ts";
import { csharpMetricRules } from "./metric-rules.ts";
import { isProjectFile } from "./projects.ts";
import { resolveCsharp } from "./resolve.ts";

/** A folder or file that names tests: `Billing.Tests/`, `tests/`, `InvoiceTests.cs`, `InvoiceSpec.cs`. */
const testFolder = /^(tests?|unittests?|integrationtests?|specs?)$|\.(tests?|unittests?|integrationtests?|specs?)$/i;
const testFile = /(?:Tests?|Specs?)\.cs$/;

/**
 * C#: symbol-based. A file names no file; it brings namespaces into scope with `using` and refers to types by
 * name, so the adapter declares the types of each file and the names each file uses, and `resolveCsharp`
 * resolves them within a project and the projects it references. Partial classes are one unit across files.
 * Projects (`.csproj`) and solutions are the boundaries. A move changes no name, so it is only a file move.
 */
export const adapter: LanguageAdapter = {
  id: "csharp",
  name: "C#",
  tier: 1,
  support: "supported",
  lexerProfile: "csharp",
  grammars: [{ spec: { id: "csharp", packageName: "tree-sitter-c-sharp", file: "tree-sitter-c_sharp.wasm" }, extensions: [".cs"] }],
  extractorVersion,
  extract: extractFacts,
  isTestPath: (path) => path.split("/").slice(0, -1).some((folder) => testFolder.test(folder)) || testFile.test(path),
  metrics: csharpMetricRules,
  dependencies: { model: "symbol-based", isConfigPath: isProjectFile, resolve: resolveCsharp },
  boundaries: csharpBoundaries,
  census: { extract: extractFileCensus },
  packaging: { ecosystems: ["dotnet"], description: "C#" },
  abstractTypes: { typeKinds: ["interface", "abstract-class", "class", "enum"], abstractKinds: ["interface", "abstract-class"] },
  mover: { kind: "file-move", sourceExtensions: [".cs"], confirmation: { name: "roslyn-lsp", executable: "Microsoft.CodeAnalysis.LanguageServer" } },
};
