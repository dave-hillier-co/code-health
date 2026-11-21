import type { LanguageAdapter } from "../../language-adapter.ts";
import { rustBoundaries } from "./boundaries.ts";
import { extractFileCensus } from "./census.ts";
import { extractFacts, extractorVersion } from "./extract-facts.ts";
import { rustMetricRules } from "./metric-rules.ts";
import { isConfigPath, PathResolver } from "./resolve-path.ts";

/**
 * Rust: import-based, over the module tree and `use` paths. `mod name;` names a file, a `use` names a path
 * from the crate root, the file's module or its parents, and a crate resolves to its library root, so the
 * resolution is precise and needs no compiler. Cargo manifests give the crates and the fixed points.
 * Traits are the abstract types: a trait is an interface, a struct or enum a class. Moves are made by the
 * mover of the locality plugin, and rust-analyzer, when installed, confirms them.
 */
export const adapter: LanguageAdapter = {
  id: "rust",
  name: "Rust",
  tier: 2,
  support: "experimental",
  lexerProfile: "rust",
  grammars: [{ spec: { id: "rust", packageName: "tree-sitter-rust", file: "tree-sitter-rust.wasm" }, extensions: [".rs"] }],
  extractorVersion,
  extract: extractFacts,
  isTestPath: (path) => /(^|\/)tests\//.test(path) || /(^|\/)tests?\.rs$/.test(path) || /_tests?\.rs$/.test(path),
  metrics: rustMetricRules,
  dependencies: {
    model: "import-based",
    isConfigPath,
    createResolver: (paths, configs) => new PathResolver(paths, configs),
  },
  boundaries: rustBoundaries,
  census: { extract: extractFileCensus },
  packaging: { ecosystems: ["cargo"], description: "Rust" },
  abstractTypes: { typeKinds: ["interface", "class", "enum"], abstractKinds: ["interface"] },
  mover: { kind: "codemod", sourceExtensions: [".rs"], confirmation: { name: "rust-analyzer", executable: "rust-analyzer" } },
};
