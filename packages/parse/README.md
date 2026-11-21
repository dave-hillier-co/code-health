# parse

The structural layer: web-tree-sitter loading, a parse cache, and the TypeScript/JavaScript adapter.

## Grammars

Grammars come from npm packages that ship prebuilt `.wasm` files, so there are no native builds:

| Grammar | Package | File |
|---|---|---|
| `typescript` (`.ts`, `.mts`, `.cts`) | `tree-sitter-typescript` | `tree-sitter-typescript.wasm` |
| `tsx` (`.tsx`) | `tree-sitter-typescript` | `tree-sitter-tsx.wasm` |
| `javascript` (`.js`, `.jsx`, `.mjs`, `.cjs`) | `tree-sitter-javascript` | `tree-sitter-javascript.wasm` |
| runtime | `web-tree-sitter` | `web-tree-sitter.wasm` |

A plugin that parses ships these next to its bundle, in `dist/grammars/`. `grammars.ts` resolves them relative to `import.meta.url`: `grammars/` beside the bundle first, then the npm package when running from source. A plugin's build script bundles its CLI with esbuild and then calls `copyGrammars(<plugin>/dist/grammars)` from `copy-grammars.ts`, which copies exactly the files listed above.

A grammar's version is a hash of the bytes of its `.wasm` and of the runtime's, so it is available in a bundle and cannot drift from what was loaded.

## Parse cache

`.cache/code-health/parse/<grammar version>.extract-<n>/<blob prefix>/<blob sha>.json`. Entries are keyed by git blob SHA, grammar version and the extractor's own version, so unchanged files are never parsed again and a historical revision is analysed by its blobs. Facts never contain paths, so a renamed file reuses its entry.

## Adapter

`analyseTree(tree)` takes a `SourceTree` (a git ref or a directory) and returns units, import edges, consumers, file edges, barrels and unresolved imports. `dependency-graphs.ts` turns those into plain adjacency over path and symbol ids.

Conformance fixtures are directories under `fixtures/ts-adapter/`, each with an `expected.json` of hand-verified values.
