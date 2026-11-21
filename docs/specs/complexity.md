# Complexity Tool — Spec

Part of the code-health suite. Read [suite.md](suite.md) for shared conventions and [red-flags.md](../../shared/red-flags.md) for the design vocabulary the skill uses.

## Purpose

The tool measures how hard individual functions and files are to understand, flags where that difficulty sits in code that actually changes, and guides simplifications that reduce cognitive load without scattering code. It also gives agents fast feedback on the code they have just written.

Traditional metrics are useful and easily misused. Ranked alone, they produce long lists of old, stable code nobody needs to touch. Used as hard gates, they reward splitting functions into shallow helpers that pass the threshold and make the system harder to follow. This tool counters both. It ranks by complexity in changing code, gates only on regressions, and steers remedies towards deeper modules rather than more of them.

## Organisation: one plugin, many metrics

The traditional metrics ship as **one plugin with pluggable metrics**, not one plugin per metric.

- All metrics share one parse, one definition of a function and one per-language adapter. Separate plugins would each bundle the tree-sitter runtime and grammars (several MB each), and would each identify functions slightly differently, so their results would not line up.
- Users and agents ask one question, "what is hard to understand here?", not "what is the cyclomatic complexity?". One skill answering that question with several metrics is easier to trigger correctly than several narrow skills.
- Inside the plugin, each metric is an independent module: a pure function from a function's syntax node (through the language adapter) to a value. Adding a metric means adding a module, a schema field and tests. `--metrics` selects a subset.

A separate plugin is justified only when an analysis needs different inputs or a different workflow. Duplication detection and standard-library idiom replacement are examples (see [suite.md](suite.md#roadmap)).

## Scope

In scope:

- Language-agnostic metrics from the lexical layer for every language: indentation complexity, bumpy road, nesting, keyword complexity, length.
- Per-function structural metrics for supported languages: cyclomatic complexity, cognitive complexity, maximum nesting depth, length, parameter count.
- Per-file aggregates and a language-agnostic indentation complexity for files in unsupported languages.
- Interface depth signals: the shallow-module and pass-through red flags.
- A ratchet for CI against a base revision, so only new or worsened functions fail.
- Diff mode, measuring only the functions a change touched.
- An opt-in post-edit hook giving the agent immediate feedback.

Out of scope:

- Maintainability index, because it is a composite with opaque weights, poor evidence and no actionable remedy.
- Halstead metrics as a default. They are available as an optional metric module if someone wants them, but they are not ranked or gated on.
- Code formatting and style.
- Automatic refactoring. The agent performs simplifications, guided by the skill.

## Metrics

Each metric has a precise per-language definition, captured in the language adapter's tree-sitter queries and covered by fixture tests per language. The definitions below are the language-neutral intent.

### Language-agnostic metrics (lexical layer)

These are the lowest common denominator, offered at best effort ([suite.md](suite.md#analysis-layers)). Indentation complexity, nesting and file length work on any text file and any historical blob. Function blocks and the metrics built on them (bumpy road, keyword complexity, per-function length) need a lexer profile. They are the default for tier-0 languages and for trends, and they are reported alongside the structural metrics everywhere.

**Function blocks.** Approximate units found lexically: a line matching the profile's definition shape followed by a block, closed by brace matching (skipping strings and comments) or by indentation returning to the opening level. They are approximate. Their agreement with the structural layer is measured per language ([suite.md](suite.md#testing)), and per-function lexical metrics are reported only where it clears the configured bar, with the rate attached. Lexical blocks are never used for unit identity in `check` and `diff`, which stays structural.

**Indentation complexity.** The sum of logical indentation levels over non-blank lines, leaving out comment lines where a lexer profile identifies them, normalised by the detected indent unit. It is one definition, implemented once in the shared `lexical` package and used by cochange too.

**Maximum nesting.** The maximum logical indentation within a block, relative to the block's base.

**Bumpy road.** A function with several separate chunks of nested logic. Each chunk is a sign of a responsibility that has not been named. Lexically, a *bump* is a maximal run of lines indented at least the bump depth (default 2 levels) deeper than the function's base, opened by a branch keyword on the line just before the run. Bumps are separated by lines back at a shallower level. The function reports `bumps` (count), `bumpDepth` (the deepest bump) and `bumpSize` (lines in the largest bump). A function is a bumpy road at the configured threshold (default 3 bumps, or 2 when any bump is deeper than the nesting threshold). The structural layer computes the same measure from the syntax tree when available, counting nested control-flow regions rather than indentation runs.

**Keyword complexity.** A count of the profile's branch keywords and short-circuit operators per block, outside strings and comments. It is a lexical approximation of cyclomatic complexity.

**Length.** Non-blank, non-comment lines per block.

Remedies for a bumpy road follow the same policy as for any complexity. Each bump is first a candidate for simplification in place (guard clauses, removing impossible branches, flattening). Only when a bump is a distinct responsibility does it become a candidate for extraction, as a deep, well-named, local function. A bumpy road is not resolved by mechanically extracting each bump into its own helper.

### Cyclomatic complexity (McCabe)

`1 + decision points`. Decision points: `if`, `else if`, each loop, each `case` (or `1` per `switch` in *modified* mode, configurable), `catch`, the ternary operator, and each short-circuit boolean operator (`&&`, `||`, `??`, `and`, `or`). Optional chaining is not counted. It bounds the number of test paths, which makes it a measure of testability more than readability.

### Cognitive complexity

Follows the SonarSource cognitive complexity specification (G. Ann Campbell, 2017), because it is documented, widely adopted and matches how hard code is to read:

- +1 for each break in linear flow: `if`, `else if`, `else`, ternary, `switch`, loops, `catch`, `goto`/labelled jumps, and each sequence of like boolean operators.
- An additional +nesting for each of those when nested inside another flow structure or a nested function.
- +1 for direct recursion.
- No increment for shorthand that aids reading, such as null-coalescing.

Nested functions and lambdas add to the enclosing function's score, following the specification, and are also reported as units in their own right with `parent` set.

### Nesting depth

The maximum nesting of control structures within the function.

### Length

Lines of code, excluding blank lines and comments, plus a statement count. Length is reported and ranked but **never gated alone**. A long, linear function is often clearer than five shallow fragments (see [red-flags.md](../../shared/red-flags.md)).

### Parameter count

Declared parameters. Destructured object parameters count as one parameter plus a reported `optionCount`, since option bags are a common route to *overexposure*.

### Interface depth

For each exported function, class or module: implementation size (AST nodes) divided by interface size (parameters + exported members). It is reported as a signal for the *shallow module* red flag. A *pass-through* signal fires when a function body is a single forwarded call.

### File aggregates

Per file: function count, sum and max of each metric, and the count of functions over threshold. Sums take top-level units only, because a nested function already adds to its parent's score and would otherwise be counted twice. For unsupported languages, only indentation complexity (shared definition with the cochange plugin) and line counts.

## Units and identity

A unit is a function, method, constructor, accessor, or a lambda or closure with a body. Each unit has a stable identity, `path#Qualified.name`, with an ordinal suffix for duplicate names in one scope. The identity is used for diffs and the ratchet. When a function is renamed or moved, the comparison matches it by body similarity before treating it as new. An unmatched unit counts as new, so moving code never hides a regression from the ratchet without the agent having looked at it.

## Ranking

Absolute thresholds are reported but **ranking is relative and change-weighted**:

1. Each function gets a percentile per metric within the repository.
2. When history is available (the shared history cache, which this plugin can refresh itself), the function's file change frequency (or the function's own, once symbol-level co-change exists) weights the rank. Complexity in code that never changes ranks last.
3. Default output is the top N by weighted rank, with the metric that dominated.

Default thresholds, which are configurable and used for `check` and labelling only: cyclomatic 10 (warn) / 20 (high), cognitive 15 / 25, nesting 4, parameters 5. There is no default length threshold.

## CLI

| Command | Output |
|---|---|
| `complexity analyse [PATHS] [--metrics m1,m2] [--layer auto\|lexical\|structural] [--limit N]` | Ranked functions with all selected metrics, percentile, change weight and labels. |
| `complexity files [PATHS]` | File-level aggregates. A full run writes the `complexity.files` report that other plugins read. |
| `complexity diff BASE[..HEAD]` | Only units added or changed between two revisions, with before and after values. Without HEAD, compares against the working tree. |
| `complexity check [--base REV]` | Compares units against a base revision (default: the merge base with the configured main branch). Exits 1 if a new unit exceeds a threshold, or an existing unit is over a threshold and worsened by more than the configured delta. A unit that stays under its thresholds never fails. Built for CI and pre-commit. |
| `complexity explain UNIT` | Line-by-line breakdown of where each increment came from. Lets the agent target the exact construct. |

## Agent integration

### Post-edit feedback hook (opt-in)

A `PostToolUse` hook on `Edit` and `Write` for any language with a lexer profile (bumpy road, nesting and keyword complexity), with structural metrics where an adapter exists:

- Measures only the edited file. Each run is a fresh process, so nothing is incremental: the budget (about 150 ms) has to cover process start and, for structural metrics, loading the WASM runtime and one grammar. The hook uses the lexical layer by default, and the structural layer only for languages where the benchmark fixture shows it fits the budget.
- Compares the file's units against the last measurement in the hook's session state ([suite.md](suite.md#hooks)), or against the values at HEAD when the session has none.
- Stays silent unless a unit crossed a threshold or worsened by more than the configured delta. When it speaks, it gives a single line with the unit, the metric, the before and after values, and the `explain` command.
- Never blocks.

This is the cheapest point to fix complexity: the agent has the code in context and has not yet built on it.

### Skill guidance

The skill holds the remedy policy, which is the main point of the plugin:

1. **Locate the cost.** Run `explain` and find which constructs contribute. Name the red flag, usually *nonobvious code*, *special-general mixture* or *shallow module*.
2. **Prefer simplification that deletes.** Guard clauses instead of nested `if`, removing dead or impossible branches, replacing flags with separate call paths at the caller, table-driven dispatch, defining error cases out of existence, and standard-library constructs.
3. **Prefer deepening over splitting.** If a function must be split, the extracted part must be a deep, well-named unit that hides a decision. It stays in the same file and is module-private unless evidence says otherwise. This keeps the complexity plugin from creating the distant, single-use helpers the locality plugin exists to remove.
4. **Never game the metric.** Moving conditionals into lookup objects that encode the same branching, or splitting a function purely to pass a threshold, counts as a regression in review.
5. **Tests first.** Simplifications are behaviour-preserving refactorings. Characterisation tests come first if coverage is thin, and each simplification is its own commit with tests green.

## Measurement

| Measure | What it shows | Role |
|---|---|---|
| Change cost in acted-on functions: subsequent commits touching them, lines churned per change, and agent reads per task touching them | Simplified code got cheaper to change | Primary outcome |
| Fix-commit rate in acted-on files (commit-message convention) | Fewer defects where complexity was reduced | Secondary outcome, when the repo's conventions allow it |
| Weighted complexity rank of acted-on units | The code got simpler | Leading indicator only |
| Function count and mean interface depth in acted-on files | Guard against shallow splitting | Gaming check |

A rising function count with falling interface depth after a simplification campaign is a sign the metric is being gamed, and the skill reports it.

## Configuration

In the `complexity` section of the suite config:

- Enabled metrics and thresholds per metric, with optional per-glob overrides (generated code, tests).
- Cyclomatic `switch` mode.
- Base revision for `check`, and the worsening delta it and the hook share.
- The agreement bar for per-function lexical metrics.
- Hook enablement.
- Whether tests are analysed (default: analysed, but ranked separately).

## Languages

The plugin supports the suite's tier-1 languages through tree-sitter adapters (see [suite.md](suite.md#languages)). An adapter provides queries for function units, decision points, nesting structures, boolean-operator sequences, parameters and exports, and must pass the shared metric conformance fixtures before it is listed as supported.

## Decisions

- **One plugin, pluggable metrics**, for the reasons above.
- **Cognitive complexity follows the SonarSource specification exactly**, so results can be compared with a widely used tool and the definition is not re-litigated.
- **Ratchet, not gate.** A hard threshold on an existing codebase produces a backlog nobody burns down, or a blanket waiver. The ratchet compares against a base revision, not a committed baseline file: a file holding every unit's values would conflict on every merge, and the blob-keyed parse cache makes the base revision cheap to measure.
- **No length threshold**, following Ousterhout's argument against shallow decomposition.

## Open questions

- Whether symbol-level co-change, from mapping diff hunks onto function ranges, belongs here (this plugin already parses) or in cochange.
- How strict body-similarity matching should be for unit identity across moves.
- Whether the hook should also report *improvements*. That would be positive feedback for the agent, at a token cost.

## Milestones

1. Lexical layer: C-family and indentation profiles, function blocks, indentation complexity, bumpy road, keyword complexity, with fixtures in several languages. File-level metrics ship first. Per-function lexical metrics wait for the agreement test in milestone 2.
2. Language adapter for TypeScript; cyclomatic, cognitive, nesting, length and parameters with conformance fixtures, and the lexical agreement test against it.
3. `analyse`, `files` and `explain` with JSON schemas.
4. `check` and `diff` against a base revision, for CI.
5. Skill remedy policy and plugin packaging.
6. Change-weighted ranking from the shared history cache.
7. Post-edit hook.
8. Interface depth and pass-through signals.
9. C#, then C++, then the tier-2 languages.
