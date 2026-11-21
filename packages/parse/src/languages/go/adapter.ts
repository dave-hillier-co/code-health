import type { LanguageAdapter } from "../../language-adapter.ts";
import { goBoundaries } from "./boundaries.ts";
import { extractFileCensus } from "./census.ts";
import { extractFacts, extractorVersion } from "./extract-facts.ts";
import { isGoModFile, isGoWorkFile } from "./go-mod.ts";
import { goMetricRules } from "./metric-rules.ts";
import { resolvePackages } from "./resolve-packages.ts";

/**
 * Go: import paths resolved through go.mod to package directories, then symbol-based within a package.
 * Build constraints are parsed as written, so every file of a directory is read whatever its `//go:build`
 * line says. Generated files are excluded (their facts are empty).
 */
export const adapter: LanguageAdapter = {
  id: "go",
  name: "Go",
  tier: 2,
  support: "experimental",
  lexerProfile: "go",
  grammars: [{ spec: { id: "go", packageName: "tree-sitter-go", file: "tree-sitter-go.wasm" }, extensions: [".go"] }],
  extractorVersion,
  extract: extractFacts,
  isTestPath: (path) => path.endsWith("_test.go") || /(^|\/)testdata\//.test(path),
  metrics: goMetricRules,
  dependencies: {
    model: "symbol-based",
    isConfigPath: (path) => isGoModFile(path) || isGoWorkFile(path),
    resolve: resolvePackages,
  },
  boundaries: goBoundaries,
  census: { extract: extractFileCensus },
  packaging: { ecosystems: ["go"], description: "Go" },
  abstractTypes: { typeKinds: ["interface", "class", "type"], abstractKinds: ["interface"] },
  mover: { kind: "codemod", sourceExtensions: [".go"], confirmation: { name: "gopls", executable: "gopls" } },
};
