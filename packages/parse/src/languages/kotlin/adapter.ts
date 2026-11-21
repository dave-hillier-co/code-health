import type { LanguageAdapter } from "../../language-adapter.ts";
import { jvmBoundaries } from "../jvm/boundaries.ts";
import { isJvmTestPath, jvmDependencies } from "../jvm/dependencies.ts";
import { extractFileCensus } from "./census.ts";
import { extractFacts } from "./extract-facts.ts";
import { kotlinRepairs } from "./grammar-repair.ts";
import { kotlinMetricRules } from "./metric-rules.ts";

/**
 * Kotlin: symbol-based, resolved in one graph with Java so a mixed project resolves across both. `internal`
 * and `private` declarations are not part of a module's surface. Gradle (and Maven) modules are its boundaries.
 */
export const adapter: LanguageAdapter = {
  id: "kotlin",
  name: "Kotlin",
  tier: 2,
  support: "supported",
  lexerProfile: "kotlin",
  grammars: [{ spec: { id: "kotlin", packageName: "@tree-sitter-grammars/tree-sitter-kotlin", file: "tree-sitter-kotlin.wasm", repairs: kotlinRepairs }, extensions: [".kt"] }],
  extractorVersion: 2,
  extract: extractFacts,
  isTestPath: (path) => isJvmTestPath(path, /\.kt$/),
  metrics: kotlinMetricRules,
  dependencies: jvmDependencies,
  boundaries: jvmBoundaries,
  census: { extract: extractFileCensus },
  packaging: { ecosystems: ["gradle", "maven"], description: "Kotlin" },
  abstractTypes: { typeKinds: ["interface", "abstract-class", "class", "enum"], abstractKinds: ["interface", "abstract-class"] },
  mover: { kind: "codemod", sourceExtensions: [".kt"], confirmation: { name: "kotlin-lsp", executable: "kotlin-lsp" } },
};
