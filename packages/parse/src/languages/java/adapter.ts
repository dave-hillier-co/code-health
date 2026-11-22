import type { LanguageAdapter } from "../../language-adapter.ts";
import { jvmBoundaries } from "../jvm/boundaries.ts";
import { isJvmTestPath, jvmDependencies } from "../jvm/dependencies.ts";
import { extractFileCensus } from "./census.ts";
import { extractFacts } from "./extract-facts.ts";
import { javaMetricRules } from "./metric-rules.ts";

/**
 * Java: symbol-based, sharing one graph with Kotlin. A package maps to a folder, so a file sees its own
 * package and what it imports, and Gradle and Maven modules are its boundaries.
 */
export const adapter: LanguageAdapter = {
  id: "java",
  name: "Java",
  tier: 2,
  support: "supported",
  lexerProfile: "java",
  grammars: [{ spec: { id: "java", packageName: "tree-sitter-java", file: "tree-sitter-java.wasm" }, extensions: [".java"] }],
  extractorVersion: 3,
  extract: extractFacts,
  isTestPath: (path) => isJvmTestPath(path, /\.java$/),
  metrics: javaMetricRules,
  dependencies: jvmDependencies,
  boundaries: jvmBoundaries,
  census: { extract: extractFileCensus },
  packaging: { ecosystems: ["gradle", "maven"], description: "Java" },
  abstractTypes: { typeKinds: ["interface", "abstract-class", "class", "enum"], abstractKinds: ["interface", "abstract-class"] },
  mover: { kind: "codemod", sourceExtensions: [".java"], confirmation: { name: "jdtls", executable: "jdtls" } },
};
