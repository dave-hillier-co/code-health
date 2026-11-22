# Metrics, guidelines and configuration

## How each metric is counted

All structural metrics come from the syntax tree of TypeScript and JavaScript (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`,
`.jsx`, `.mjs`, `.cjs`), C#, C++, Python, Java, Kotlin, Go or Rust. `complexity explain <rule>` lists how each language
counts the constructs it has. A unit is a named function, method, constructor, accessor, or an arrow or function expression
bound to a name. Anonymous callbacks are not units: they add to the function that contains them.

| Metric | Counted as |
|---|---|
| `cognitive` | The SonarSource cognitive complexity specification. Each of `if`, ternary, `switch`, `for`, `for-in`/`for-of`, `while`, `do`, `catch` costs 1 plus its nesting level. `else if`, `else`, a labelled `break` or `continue`, direct recursion and each run of like `&&` or `\|\|` cost a flat 1. `??`, `?.` and `try` are free. The body of a structure and any nested function sit one level deeper, and nested functions add to the enclosing score. |
| `cyclomatic` | 1 plus decision points: `if` (an `else if` is an `if`), loops, each `case` (not `default`), `catch`, the ternary, and `&&`, `\|\|`, `??` (also `&&=`, `\|\|=`, `??=`). Optional chaining is not counted. With `cyclomaticSwitch: "modified"` a `switch` counts once. |
| `nesting` | The deepest nesting of `if`, loop, `switch` and `try` statements. An `else if` sits at the level of its `if`. A nested function continues from where it sits. |
| `parameters` | Declared parameters, `this` excluded. A destructured object parameter counts once. |
| `length` | Lines of the function holding code, with blank lines and comment-only lines left out. A `statements` count of the function's statements is reported beside it, and a nested function's `parent` names the function it sits in. |
| `bumps` | Separate regions of nested control flow directly in the function: the body of each branch of an `if` chain and of a loop, and a whole `switch` or `try`. Structures inside a bump belong to it, and a body that fits on the line that opens it is not one. `bumpDepth` and `bumpSize` give the deepest level and the largest bump in code lines. Three bumps, or two when `bumpDepth` is above `guidelines.nesting`, make a `bumpy-road` label. |

A logical sequence is counted once per run of like operators, reading left to right and looking through parentheses:
`a && b && c || d` is two (an `&&` run and an `||` run). A `!` ends a sequence, so `a && !(b && c)` is two.

## The lexical layer

For files in other languages, and when `--layer lexical` is given, per-function values come from the lexical layer. It finds
function blocks by matching headers and counting braces (or indentation), outside strings and comments. Its values are
approximations and carry `source: "lexical"`.

A file type with no profile can be mapped to one in `code-health.json`, as `"languages": { "zig": "rust" }` (extension without its dot, to a profile name). Its per-function values are reported with `unverified: true`, because no agreement with a structural layer was ever measured for it. State that when quoting them, and do not rank them as firmly as measured ones. The post-edit hook prints nothing for such files.

| Metric | Counted as |
|---|---|
| `keyword` | Branch keywords and short-circuit operators in the block. An approximation of cyclomatic complexity, without the base 1. |
| `bumps` | Separate runs of lines nested two or more levels below the function, each opened by a branch keyword. Three bumps, or two when any is deeper than the nesting guideline, make a `bumpy-road` label. |
| `nesting`, `length` | As above, from indentation. |

Per-function lexical values are released only for a profile whose recorded agreement with the structural layer
reaches `agreementBar` (default 0.9) on exact function boundaries. Every supported language clears it at its recorded rate. A profile with no
structural adapter has no agreement measured, so its functions are not reported and the file gets file-level metrics
only. A language mapped to a profile by config is marked `unverified`.

File-level metrics work for any text file: `complexity` (the indentation complexity, shared with the cochange plugin),
line counts and, with a profile, `keywordComplexity`.

## Interface depth

`complexity depth` reports the signal behind the *shallow module* and *pass-through method* red flags, from the syntax tree
of any supported language. It is never gated.

| Value | Counted as |
|---|---|
| `nodes` | Named syntax nodes of the unit, itself included, comments left out. For a module, the whole file without its import statements. |
| `interface` | A function: its parameters (a destructured object counts once), at least 1. A class: its constructor parameters plus its reachable members, so everything except `private` members and `#` fields, at least 1. A module: the names it exports, re-exports included. |
| `depth` | `nodes` divided by `interface`, to two places. Higher is deeper. |
| `passThrough` | The call a function's whole body forwards to. The body is one statement that is a call (`return`, `await`, `as` and `!` do not count as work), and every argument is a parameter, a spread of one, or a literal. A `new`, a computed argument or a second statement is the function doing work. |

Rows are the exported top-level functions and classes, each module that exports something, and every pass-through, exported
or not (a method of an exported class counts as exported). A row is `shallow` when it is exported, is not a method and has
fewer than `interfaceDepth.shallow` (default 10) nodes per interface element. Pass-throughs sort first, then the shallowest.
A small helper with one clear purpose is often shallow and right: read before acting. `files` carries `interfaceDepth`, the
mean depth over a file's exported functions and classes, and `passThroughs`, so a campaign can be checked for splitting.

## Guidelines

The values are guidelines for investigation, configured under `guidelines`. A metric is above its guideline when its value is **above** it. Output labels it and sorts by how far above, and hides nothing. Only `check` reads `warn` as an exit code, for new or worsened functions. `high` only changes the label. The defaults are McCabe's 10 and SonarSource's 15, CodeScene's nesting 4, and judgement calls for the rest.

| Metric | warn | high |
|---|---|---|
| `cyclomatic` | 10 | 20 |
| `cognitive` | 15 | 25 |
| `nesting` | 4 | |
| `parameters` | 5 | |

There is no length guideline, on purpose.

## Configuration

The `complexity` section of `code-health.json`. Missing keys take the defaults, unknown keys are an error.

| Key | Default | Meaning |
|---|---|---|
| `metrics` | all | Metrics reported and ranked. `--metrics a,b` narrows one run. |
| `guidelines` | above | `{ cyclomatic: { warn, high }, cognitive: { warn, high }, nesting, parameters, bumps, deepBumps }`. `bumps` (3) and `deepBumps` (2) are the bump counts that make a bumpy road, the second applying when the deepest bump is deeper than `nesting`. |
| `cyclomaticSwitch` | `case` | `case` or `modified` |
| `base` | `null` | Base revision for `check`. `null` is the merge base with the main branch. |
| `mainBranch` | `null` | The branch `check` forks from. `null` tries `origin/main`, `main`, `origin/master`, `master`. |
| `delta` | `0` | How much a metric above its guideline may rise before `check` exits with 1. |
| `agreementBar` | `0.9` | Agreement a lexer profile needs for per-function lexical metrics. |
| `moveSimilarity` | `0.8` | Body similarity at which a function that disappeared and one that appeared are one function moved or renamed. |
| `analyseTests` | `true` | Analyse test files. They are ranked among themselves, never against production code. |
| `interfaceDepth` | `{ "shallow": 10 }` | Nodes per interface element below which an exported unit is labelled `shallow`. |
| `hook` | `{ "enabled": false }` | The post-edit hook, off unless a repository turns it on. See [hook.md](hook.md). |
| `overrides` | `[]` | `{ "paths": [globs], "guidelines": { ... } }`, applied in order over the defaults. For generated code, fixtures and the like. |

The suite's shared `exclude` globs leave files out entirely.

The change window (`windowMonths`, default 12), `maxChangesetSize`, `botPatterns` and the fix definition (`fixPatterns`, `revertPatterns`, `fixMatchBody`) come from the shared top-level `history` section, and a `complexity` key of the same name overrides one of them.

`node ${CLAUDE_PLUGIN_ROOT}/dist/complexity.mjs config explain` prints the effective config and where each value came from.
