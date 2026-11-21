import type { LanguageAdapter } from "../../language-adapter.ts";
import { pythonBoundaries } from "./boundaries.ts";
import { extractFileCensus } from "./census.ts";
import { extractFacts, extractorVersion } from "./extract-facts.ts";
import { pythonMetricRules } from "./metric-rules.ts";
import { isConfigPath, PythonResolver } from "./resolve-module.ts";

/**
 * Python: import-based, with package roots found from the layout of the tree and `__init__.py` re-exports
 * followed through to the definition. Distributions (`pyproject.toml`) are the boundaries. Dynamic imports
 * (`importlib.import_module`, `__import__`) are reported as unresolved and need configured entry points.
 */
export const adapter: LanguageAdapter = {
  id: "python",
  name: "Python",
  tier: 2,
  support: "supported",
  lexerProfile: "python",
  grammars: [{ spec: { id: "python", packageName: "tree-sitter-python", file: "tree-sitter-python.wasm" }, extensions: [".py"] }],
  extractorVersion,
  extract: extractFacts,
  isTestPath: (path) => /(^|\/)(tests?|__tests__)\//.test(path) || /(^|\/)(test_[^/]*|[^/]*_test|conftest|tests)\.py$/.test(path),
  metrics: pythonMetricRules,
  dependencies: {
    model: "import-based",
    isConfigPath,
    createResolver: (paths) => new PythonResolver(paths),
  },
  boundaries: pythonBoundaries,
  census: { extract: extractFileCensus },
  packaging: { ecosystems: ["python"], description: "Python" },
  // A `Protocol` is an interface and an `ABC` an abstract class (see classKind).
  abstractTypes: { typeKinds: ["interface", "abstract-class", "class", "enum"], abstractKinds: ["interface", "abstract-class"] },
  mover: { kind: "codemod", sourceExtensions: [".py"], confirmation: { name: "rope", executable: "python3" } },
};
