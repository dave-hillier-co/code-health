# Metrics, thresholds and configuration

## How each metric is counted

All structural metrics come from the syntax tree of TypeScript and JavaScript (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`,
`.jsx`, `.mjs`, `.cjs`). A unit is a named function, method, constructor, accessor, or an arrow or function expression
bound to a name. Anonymous callbacks are not units: they add to the function that contains them.

| Metric | Counted as |
|---|---|
| `cognitive` | The SonarSource cognitive complexity specification. Each of `if`, ternary, `switch`, `for`, `for-in`/`for-of`, `while`, `do`, `catch` costs 1 plus its nesting level. `else if`, `else`, a labelled `break` or `continue`, direct recursion and each run of like `&&` or `\|\|` cost a flat 1. `??`, `?.` and `try` are free. The body of a structure and any nested function sit one level deeper, and nested functions add to the enclosing score. |
| `cyclomatic` | 1 plus decision points: `if` (an `else if` is an `if`), loops, each `case` (not `default`), `catch`, the ternary, and `&&`, `\|\|`, `??` (also `&&=`, `\|\|=`, `??=`). Optional chaining is not counted. With `cyclomaticSwitch: "modified"` a `switch` counts once. |
| `nesting` | The deepest nesting of `if`, loop, `switch` and `try` statements. An `else if` sits at the level of its `if`. A nested function continues from where it sits. |
| `parameters` | Declared parameters, `this` excluded. A destructured object parameter counts once. |
| `length` | Lines of the function holding code, with blank lines and comment-only lines left out. |

A logical sequence is counted once per run of like operators, reading left to right and looking through parentheses:
`a && b && c || d` is two (an `&&` run and an `||` run). A `!` ends a sequence, so `a && !(b && c)` is two.

## The lexical layer

For files in other languages, and when `--layer lexical` is given, per-function values come from the lexical layer. It finds
function blocks by matching headers and counting braces (or indentation), outside strings and comments. Its values are
approximations and carry `source: "lexical"`.

| Metric | Counted as |
|---|---|
| `keyword` | Branch keywords and short-circuit operators in the block. An approximation of cyclomatic complexity, without the base 1. |
| `bumps` | Separate runs of lines nested two or more levels below the function, each opened by a branch keyword. Three bumps, or two when any is deeper than the nesting threshold, make a `bumpy-road` label. |
| `nesting`, `length` | As above, from indentation. |

Per-function lexical values are released only for a profile whose recorded agreement with the structural layer
reaches `agreementBar` (default 0.9) on exact function boundaries. TypeScript and JavaScript clear it. A profile with no
structural adapter has no agreement measured, so its functions are not reported and the file gets file-level metrics
only. A language mapped to a profile by config is marked `unverified`.

File-level metrics work for any text file: `complexity` (the indentation complexity, shared with the cochange plugin),
line counts and, with a profile, `keywordComplexity`.

## Thresholds

A metric is over its threshold when its value is **above** it. Only `warn` gates `check`. `high` only changes the label.

| Metric | warn | high |
|---|---|---|
| `cyclomatic` | 10 | 20 |
| `cognitive` | 15 | 25 |
| `nesting` | 4 | |
| `parameters` | 5 | |

There is no length threshold, on purpose.

## Configuration

The `complexity` section of `code-health.json`. Missing keys take the defaults, unknown keys are an error.

| Key | Default | Meaning |
|---|---|---|
| `metrics` | all | Metrics reported and ranked. `--metrics a,b` narrows one run. |
| `thresholds` | above | `{ cyclomatic: { warn, high }, cognitive: { warn, high }, nesting, parameters }` |
| `cyclomaticSwitch` | `case` | `case` or `modified` |
| `base` | `null` | Base revision for `check`. `null` is the merge base with the main branch. |
| `mainBranch` | `null` | The branch `check` forks from. `null` tries `origin/main`, `main`, `origin/master`, `master`. |
| `delta` | `0` | How much an over-threshold metric may rise before `check` fails it. |
| `agreementBar` | `0.9` | Agreement a lexer profile needs for per-function lexical metrics. |
| `moveSimilarity` | `0.8` | Body similarity at which a function that disappeared and one that appeared are one function moved or renamed. |
| `analyseTests` | `true` | Analyse test files. They are ranked among themselves, never against production code. |
| `overrides` | `[]` | `{ "paths": [globs], "thresholds": { ... } }`, applied in order over the defaults. For generated code, fixtures and the like. |

The suite's shared `exclude` globs leave files out entirely.

`node ${CLAUDE_PLUGIN_ROOT}/dist/complexity.mjs config explain` prints the effective config and where each value came from.
