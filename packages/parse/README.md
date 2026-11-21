# parse

The structural layer: web-tree-sitter loading, a parse cache, the language adapter contract and the adapters that implement it.

## Language adapters

A language is a `LanguageAdapter` (`language-adapter.ts`) in `languages/<id>/adapter.ts`, registered by one line in `registered-adapters.ts`. `languages.ts` is the registry every plugin asks (`adapterForPath`, `isTestPath`, `discoverBoundaries`, ...); no plugin imports a language. CONTRIBUTING.md lists every file a new language adds.

| Member | Provides |
|---|---|
| `grammars`, `extract`, `extractorVersion` | Tree-sitter grammars with their extensions, and the facts of a file: units with qualified names, and the imports, exports and references (import-based) or the symbols (symbol-based) that dependencies are resolved from. |
| `dependencies` | `import-based`: a module resolver, followed through barrels by the shared `import-model.ts`. `symbol-based`: the shared `symbol-model.ts` resolves declared names through namespaces and usings, or the adapter replaces it. Adapters sharing a `group` (Java and Kotlin) resolve together. Both give units with symbol ids `path#qualifiedName`, file edges and consumers with kinds. |
| `boundaries` | Fixed points discovered from manifests, with the entry files a manifest publishes. |
| `metrics` | `MetricRules`: the construct mapping behind the shared metric engine in `unit-metrics.ts`. |
| `census` | Syntactic facts for the structure census (`census-facts.ts`). |
| `packaging`, `abstractTypes` | The ecosystems whose packages the adapter reads, and which declarations count as types and as abstract. |
| `mover` | What locality can do: a deterministic codemod, a file move, or an agent edit, and an optional external tool that confirms references. |
| `support` | `experimental` until the conformance suites pass for every plugin, then `supported`. Only supported adapters analyse repositories and ship grammars. |

## Grammars

Grammars come from npm packages that ship prebuilt `.wasm` files, so there are no native builds. Each adapter lists its grammars and their extensions:

| Grammar | Package | File |
|---|---|---|
| `typescript` (`.ts`, `.mts`, `.cts`) | `tree-sitter-typescript` | `tree-sitter-typescript.wasm` |
| `tsx` (`.tsx`) | `tree-sitter-typescript` | `tree-sitter-tsx.wasm` |
| `javascript` (`.js`, `.jsx`, `.mjs`, `.cjs`) | `tree-sitter-javascript` | `tree-sitter-javascript.wasm` |
| runtime | `web-tree-sitter` | `web-tree-sitter.wasm` |

A plugin that parses ships the grammar of every supported adapter next to its bundle, in `dist/grammars/`, and loads only the ones the repository it analyses has files for (`GrammarSet` loads a grammar when the first file needs it). `grammars.ts` resolves them relative to `import.meta.url`: `grammars/` beside the bundle first, then the npm package when running from source. A plugin's build script bundles its CLI with esbuild and then calls `copyGrammars(<plugin>/dist/grammars)` from `copy-grammars.ts`, which copies the runtime and `shippedGrammarSpecs()`.

A grammar's version is a hash of the bytes of its `.wasm` and of the runtime's, so it is available in a bundle and cannot drift from what was loaded.

## Parse cache

`.cache/code-health/parse/<grammar version>.<adapter id>-extract-<n>/<blob prefix>/<blob sha>.json`. Entries are keyed by git blob SHA, grammar version and the adapter's own extractor version, so unchanged files are never parsed again and a historical revision is analysed by its blobs. Facts never contain paths, so a renamed file reuses its entry.

## Analysis

`analyseTree(tree)` takes a `SourceTree` (a git ref, a directory, or `treeFromTexts`) and returns units, import edges, consumers, file edges, barrels and unresolved imports, whichever dependency model each language uses. `dependency-graphs.ts` turns those into plain adjacency over path and symbol ids.

Conformance fixtures are in `fixtures/languages/<id>/`, each case with an `expected.json` of hand-verified values. `test/language-conformance.test.ts` runs them over every registered adapter, and `test/support/toy-adapter.ts` is a made-up symbol-based language that tests the contract itself.
