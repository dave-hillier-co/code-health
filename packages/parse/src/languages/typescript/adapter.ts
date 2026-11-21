import type { LanguageAdapter } from "../../language-adapter.ts";
import { typescriptBoundaries } from "./boundaries.ts";
import { extractFileCensus } from "./census.ts";
import { extractFacts } from "./extract-facts.ts";
import { typescriptMetricRules } from "./metric-rules.ts";
import { isConfigPath, SpecifierResolver } from "./resolve-specifier.ts";

/** TypeScript and JavaScript: import-based, with tsconfig `paths`, package `exports` and barrels followed through. */
export const adapter: LanguageAdapter = {
  id: "typescript",
  name: "TypeScript/JavaScript",
  tier: 1,
  support: "supported",
  lexerProfile: "typescript",
  grammars: [
    { spec: { id: "typescript", packageName: "tree-sitter-typescript", file: "tree-sitter-typescript.wasm" }, extensions: [".ts", ".mts", ".cts"] },
    { spec: { id: "tsx", packageName: "tree-sitter-typescript", file: "tree-sitter-tsx.wasm" }, extensions: [".tsx"] },
    { spec: { id: "javascript", packageName: "tree-sitter-javascript", file: "tree-sitter-javascript.wasm" }, extensions: [".js", ".mjs", ".cjs", ".jsx"] },
  ],
  extractorVersion: 6,
  extract: extractFacts,
  isTestPath: (path) => /(^|\/)(__tests__|__mocks__|tests?)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path),
  metrics: typescriptMetricRules,
  dependencies: {
    model: "import-based",
    isConfigPath,
    createResolver: (paths, configs) => new SpecifierResolver(paths, configs),
  },
  boundaries: typescriptBoundaries,
  census: { extract: extractFileCensus },
  packaging: { ecosystems: ["npm"], description: "TypeScript or JavaScript" },
  abstractTypes: { typeKinds: ["interface", "abstract-class", "class", "enum"], abstractKinds: ["interface", "abstract-class"] },
  mover: { kind: "codemod", sourceExtensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"], confirmation: null },
};
