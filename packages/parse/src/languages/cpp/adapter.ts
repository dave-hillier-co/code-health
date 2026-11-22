import type { LanguageAdapter } from "../../language-adapter.ts";
import { cppBoundaries } from "./boundaries.ts";
import { extractFileCensus } from "./census.ts";
import { headerExtensions, inlineExtensions, sourceExtensions } from "./extensions.ts";
import { extractFacts } from "./extract-facts.ts";
import { cppMetricRules } from "./metric-rules.ts";
import { resolveCpp } from "./resolve.ts";

/** Extensions are claimed lower case, as the contract says, so `.C` and `.H` files are not read. */
const claimed: string[] = [...sourceExtensions, ...headerExtensions, ...inlineExtensions];

/**
 * C++: symbol-based for calls, with `#include` resolved against the include paths of `compile_commands.json`, and
 * a header and its source file one unit. Build targets (CMake) are the boundaries. The preprocessor is not run.
 * `.c` and `.h` files are read with the C++ grammar, which parses C. C has no adapter of its own.
 */
export const adapter: LanguageAdapter = {
  id: "cpp",
  name: "C++",
  tier: 1,
  support: "supported",
  lexerProfile: "cpp",
  grammars: [{ spec: { id: "cpp", packageName: "tree-sitter-cpp", file: "tree-sitter-cpp.wasm" }, extensions: claimed }],
  extractorVersion: 2,
  extract: extractFacts,
  isTestPath: (path) =>
    /(^|\/)(tests?|unittests?|gtest|testing)\//i.test(path) ||
    /(^|\/)(test_[^/]+|[^/]+_(test|tests|unittest|unittests)|[^/]+Tests?|[^/]+\.(test|spec))\.[^/.]+$/.test(path),
  metrics: cppMetricRules,
  dependencies: {
    model: "symbol-based",
    isConfigPath: (path) => path === "compile_commands.json" || path.endsWith("/compile_commands.json") || path === "CMakeLists.txt" || path.endsWith("/CMakeLists.txt"),
    resolve: resolveCpp,
  },
  boundaries: cppBoundaries,
  census: { extract: extractFileCensus },
  packaging: { ecosystems: ["cmake"], description: "C++" },
  abstractTypes: { typeKinds: ["interface", "abstract-class", "class", "enum"], abstractKinds: ["interface", "abstract-class"] },
  mover: { kind: "codemod", sourceExtensions: [...claimed], confirmation: { name: "clangd", executable: "clangd" } },
};
