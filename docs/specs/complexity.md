# Complexity Tool — Spec

Part of the code-health suite. Read [suite.md](suite.md) for shared conventions and [red-flags.md](../../shared/red-flags.md) for the design vocabulary the skill uses.

## Purpose

The tool measures how hard individual functions and files are to understand, flags where that difficulty sits in code that actually changes, and guides simplifications that reduce cognitive load without scattering code. It also gives agents fast feedback on the code they have just written.

Traditional metrics are useful and easily misused. Ranked alone, they produce long lists of old, stable code nobody needs to touch. Used as hard gates, they reward splitting functions into shallow helpers that pass the guideline and make the system harder to follow. This tool counters both. It ranks functions by cognitive complexity, offers a change-weighted order for code that changes, gates only on regressions, and steers remedies towards deeper modules rather than more of them.

**Guidelines, not hard limits.** Every numeric value that CodeScene or the literature gives for a metric is a *guideline*: a heuristic that tells the reader where to look. Output carries the measured value and where it sits relative to the guideline (a band word such as `above guideline`, and where useful `guideline: 4`, `ratio: 1.75`), and is sorted by how far past the guideline each item is. A guideline never hides, drops or fails an item. Output is capped by explicit, overridable limits (`--limit N`, with a count of what was left out), not by values. The only floors are minimum-evidence floors, where a statistic is meaningless below them. Findings are for investigation, so wording is "worth a look" or "above guideline", never "violation" or "too complex". The only exit code 1 in this plugin is the explicit gate of `check`. Each default has a recorded source, in [Guidelines](#guidelines).

**Terms.** A *code smell* is Fowler's: a surface indication of a deeper problem. *Code health* is what the suite quantifies, as CodeScene uses the term: how easy code is to understand and change. This tool reports measurements that bear on code health. It does not produce a single code health score, because the weights behind one are opaque.

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
- A ratchet for CI against a base revision, so only new or worsened functions make `check` exit with 1.
- Diff mode, measuring only the functions a change touched.

Out of scope:

- Maintainability index, because it is a composite with opaque weights, poor evidence and no actionable remedy.
- Halstead metrics as a default. They are available as an optional metric module if someone wants them, but they are not ranked or gated on.
- Code formatting and style.
- Automatic refactoring. The agent performs simplifications, guided by the skill.

## Metrics

Each metric has a precise per-language definition, captured in the language adapter's tree-sitter queries and covered by fixture tests per language. The definitions below are the language-neutral intent.

### Language-agnostic metrics (lexical layer)

These are the lowest common denominator, offered at best effort ([suite.md](suite.md#analysis-layers)). Indentation complexity, nesting and file length work on any text file and any historical blob. Function blocks and the metrics built on them (bumpy road, keyword complexity, per-function length) need a lexer profile. They are the default for tier-0 languages and for trends, and they are reported alongside the structural metrics everywhere. CodeScene applies one code health model to 30+ languages. Here the model is the same shared definitions with a different layer by language: structural for tier 1 and 2, and for any other language only the file-level lexical metrics, with `source` on every row saying which layer measured it.

**Function blocks.** Approximate units found lexically: a line matching the profile's definition shape followed by a block, closed by brace matching (skipping strings and comments) or by indentation returning to the opening level. They are approximate. Their agreement with the structural layer is measured per language ([suite.md](suite.md#testing)), and per-function lexical metrics are reported only where it clears the configured bar (`agreementBar`, default 0.9, a judgement call), with the rate attached. Below the bar a profile's blocks are withheld because a block that does not match its function would attribute a value to the wrong code. That is a measurement floor and not a finding filter. A profile mapped through config has no recorded agreement, so its values are reported with `unverified: true`. Lexical blocks are never used for unit identity in `check` and `diff`, which stays structural.

**Indentation complexity.** The sum of logical indentation levels over non-blank lines, leaving out comment lines where a lexer profile identifies them, normalised by the detected indent unit. Lines inside a multi-line string are left out. It is a file-level proxy in Tornhill's sense (*Your Code as a Crime Scene*), not a per-function metric, and `files` rows carry it as `complexity`. It is one definition, implemented once in the shared `lexical` package and used by cochange too.

**Maximum nesting.** The maximum logical indentation within a block, relative to the block's base.

**Bumpy road.** A function with several separate chunks of nested logic. Each chunk is a sign of a responsibility that has not been named. Lexically, a *bump* is a maximal run of lines indented at least the bump depth (default 2 levels) deeper than the function's base, opened by a branch keyword on the line just before the run. Bumps are separated by lines back at a shallower level. The function reports `bumps` (count), `bumpDepth` (the deepest bump) and `bumpSize` (lines in the largest bump). A function is labelled a bumpy road above the guideline (default 3 bumps, or 2 when any bump is deeper than the nesting guideline). The structural layer computes the same measure from the syntax tree when available, counting nested control-flow regions rather than indentation runs. A structural bump is the body of each branch of an `if` chain or of a loop, or a whole `switch` or `try`, directly in the function, and a one-line body is not a bump. A `switch` is one bump however many cases it has, which differs from CodeScene, where each indented chunk of conditional logic counts. `bumpDepth` is the nesting of the bump plus 1 and is not configurable for the structural layer. CodeScene's default is 2 bumps at depth 2, and the 3-bump default here is a judgement call. A bumpy road is a finding and is not part of `check`.

**Keyword complexity.** A count of the profile's branch keywords and short-circuit operators per block, outside strings and comments, with no base of 1, so cyclomatic complexity is one more than it. The ternary, `else` and `?:` are not counted, because tokens alone cannot tell `?:` as a ternary (C-family) from the elvis operator (Kotlin), which the structural layer counts as a cyclomatic decision. The two layers therefore differ on elvis-heavy Kotlin, and the lexical value is the approximation. Python lambdas and expression-bodied members are not blocks.

**Length.** Non-blank, non-comment lines per block.

**Hunk shapes.** The lexical layer also parses unified diff hunks and recognises append-shaped hunks (`hunk-shape.ts`), which the structure plugin reads. They are lexical output and have no complexity metric.

Remedies for a bumpy road follow the same policy as for any complexity. Each bump is first a candidate for simplification in place (guard clauses, removing impossible branches, flattening). Only when a bump is a distinct responsibility does it become a candidate for extraction, as a deep, well-named, local function. A bumpy road is not resolved by mechanically extracting each bump into its own helper.

### Cyclomatic complexity (McCabe)

`1 + decision points`. Decision points: `if`, `else if`, each loop, each `case` (or `1` per `switch` in *modified* mode, configurable), `catch`, the ternary operator, and each short-circuit boolean operator (`&&`, `||`, `??`, `and`, `or`). Optional chaining is not counted. It bounds the number of test paths, which makes it a measure of testability more than readability.

- **Units.** Named functions, methods, constructors, accessors and arrow functions bound to a name are units. An anonymous callback is not a unit and adds to the function that contains it, as CodeScene treats inline callbacks as part of the enclosing function. Decision points in a nested function count for the enclosing function, without a second base of 1.
- **Default arm.** A `default` or catch-all arm is not a case in any language but Rust, where every `match` arm counts, because the match must be exhaustive and the last arm is a choice like the others. Enum dispatch in Rust therefore scores higher, and a cross-language comparison of that one construct should allow for it.
- **Both values are stored.** `cyclomatic` counts each case and `cyclomaticModified` one per switch. `cyclomaticSwitch` (default `case`, the McCabe and CodeScene reading) chooses which one is reported.
- **Per-language readings** are in suite.md under "Metric definitions per language". For Python, a comprehension's `for` and `if` clauses add to cyclomatic complexity only (CodeScene counts comprehension conditions too), `case _` is not a decision, and a name-bound lambda is an arrow unit. In C# and C++ an `#if` branch is parsed as written, so a function with conditional compilation counts every branch of its source text, and in C++ preprocessor lines do not count toward length.

### Cognitive complexity

Follows the SonarSource cognitive complexity specification (G. Ann Campbell, 2017), because it is documented, widely adopted and matches how hard code is to read:

- +1 for each break in linear flow: `if`, `else if`, `else`, ternary, `switch`, loops, `catch`, `goto`/labelled jumps, and each sequence of like boolean operators.
- An additional +nesting for each of those when nested inside another flow structure or a nested function.
- +1 for direct recursion.
- No increment for shorthand that aids reading, such as null-coalescing.

Sequences of like `&&`/`||` cost 1, direct recursion and labelled jumps cost a flat 1, `??` and `?.` are free, and a nested function is one level deeper than where it sits. Nested functions and lambdas add to the enclosing function's score, following the specification, and are also reported as units in their own right with `parent` set.

Go has no types in the parse, so recursion is a function calling its bare name, or a method calling its own name through its receiver variable. A call on another value of the same type, such as `t.Left.Sum()`, is not detected as recursion. This is a known limitation, and the recursive-unit exemption in the metric and in locality under-fires for Go because of it.

### Nesting depth

The maximum nesting of control structures within the function: `if`, loops, `switch` and `try`, with `else if` at the level of its `if`, and a nested function continuing from the level where it sits. CodeScene's Deep Nested Complexity counts conditional depth with a default guideline of 4, which is the default here.

### Length

Lines of code, excluding blank lines and comments, plus a statement count (clauses and labels are not statements, and an expression-bodied arrow is 1). Length is reported and ranked but **never gated alone**, and has no guideline where CodeScene's Large Method uses 70 lines, following Ousterhout's argument against shallow decomposition. A long, linear function is often clearer than five shallow fragments (see [red-flags.md](../../shared/red-flags.md)).

### Parameter count

Declared parameters. Destructured object parameters count as one parameter plus a reported `optionCount`, since option bags are a common route to *overexposure*.

### Interface depth

For each exported function, class or module (and each exported pass-through method): implementation size (AST nodes) divided by interface size (parameters + exported members). It is reported as a signal for the *shallow module* red flag. A *pass-through* signal is raised when a function body is a single forwarded call. The metric is Ousterhout's (*A Philosophy of Software Design*) and not a CodeScene concept, so its definition is the node counts below. `complexity depth` and fields on `files` rows expose it. It is advisory: no command exits with 1 because of it.

- **Nodes** are the named syntax nodes of the unit, itself included, comments left out. For a module, the whole file without its import statements.
- **Interface size.** A function: its parameters, at least 1. A class: its constructor parameters plus the members a user can reach, everything but `private` members and `#` fields, at least 1. A module: the names it exports, re-exports included.
- **Pass-through.** The body is one statement that is a call, looking through `return`, `await`, `as` and `!`, and every argument is a parameter of the function, a spread of one, or a literal. A `new`, a computed argument or a second statement is the function doing work. The signal is measured for every named function or method, and `complexity depth` lists the exported ones. A pass-through that is not exported has no row and is counted in `summary.passThroughNotExported`, and `files` rows count every pass-through in `passThroughs`. The rule is strict: it has few false positives and does not match a wrapper that renames, reorders or computes an argument.
- **Exported** is decided per language by the adapter, from the declaration's own visibility. Go: a capitalised name. C#: `public` (a member also needs a `public` or `protected` modifier, and an interface member or explicit interface implementation counts as public). Java: `public` (a member needs `public` or `protected`, or sits in an interface). Kotlin: not `private` or `internal`. TypeScript and JavaScript: named by an `export` (a class member that is not `private` or a `#` field). Python: a name that does not start with an underscore, apart from dunder names. Rust: `pub` (a method of an inherent `impl` needs `pub`). C and C++: not `static`, and a member needs a `public` section. A nested function is never exported, and a method of a type that is not exported is not either.
- **Shallow** is a label, not a gate: an exported function, class or module that is not a method, with fewer than the guideline `interfaceDepth.shallow` nodes per interface element. The default of 10 is a judgement call that no corpus has calibrated, and the label does not hide anything. Rows are ordered pass-throughs first, then by depth from shallowest, whatever the guideline, and each row carries its measured `depth` and its `role`.
- It needs the structural layer, so a language without an adapter has no depth.
- The mean depth of a file's exported functions and classes, and its count of pass-throughs, sit on the `files` rows. They are the gaming check of the Measurement table.

### File aggregates

Per file: function count, sum and max of each metric, and the count of functions above guideline. Sums take top-level units only, because a nested function already adds to its parent's score and would otherwise be counted twice. For unsupported languages, only indentation complexity (shared definition with the cochange plugin) and line counts.

## Units and identity

A unit is a function, method, constructor, accessor, or a lambda or closure with a body. Each unit has a stable identity, `path#Qualified.name`, with an ordinal suffix for duplicate names in one scope. The identity is used for diffs and the ratchet. When a function is renamed or moved, the comparison matches it by body similarity before treating it as new. An unmatched unit counts as new, so moving code never hides a regression from the ratchet without the agent having looked at it.

Matching is by identity first. The leftovers are paired greedily, best first, by weighted token Jaccard similarity of their bodies at `moveSimilarity` (default 0.8, a judgement call). The 0.8 is a pairing floor, because below it two bodies are not the same unit. Whitespace-only differences are not changes, and a pure move is left out of `diff` and counted in `summary.moved`, as CodeScene's delta analysis follows code that moves. In C++ a unit name keeps its namespaces, so two same-named classes in different namespaces have different identities (see "Unit names in C++" in suite.md).

`check` and `diff` measure only the files changed between the base and the target, with the structural layer, as CodeScene's delta analysis checks changed files only. A rename appears as a delete plus an add in the file list, and the unit matching above pairs the units across it, so a rename does not hide a regression. Files with no adapter are counted in `unsupportedFiles`. `analyse` measures a clean tree at HEAD and uncommitted work from disk, untracked files that are not ignored included. A report is stored only for a whole-repository run on a clean tree.

## Ranking

Guideline values are reported, and **ranking is relative** where it uses percentiles. `complexity analyse` answers "which functions are hardest to understand?", so its default order is cognitive complexity itself, and `--by` picks another:

1. The default sorts rows by cognitive complexity, highest first, then by nesting, then cyclomatic complexity, then length, then file path and start line. The tie breakers are metrics the row shows, so a tie is visible and the same on every run. A unit that lacks a metric (the lexical layer has no cognitive complexity) counts as 0 on it. The other selected metrics stay as columns with their percentiles and guideline labels. A long keyword switch or a constructor with many parameters is an outlier of one metric, and the percentile of that metric does not move it above a function that is hard to follow.
2. `--by` takes `cognitive` (the default), `max-percentile`, `change-weighted` and each other metric name (`cyclomatic`, `nesting`, `parameters`, `length`, `keyword`, `bumps`). A metric name sorts by that metric's value. `max-percentile` sorts by `complexityScore`, the highest percentile of any selected metric, with `dominant` the metric behind it (a tie goes to the metric listed first). `change-weighted` sorts by `changeWeightedScore`, `complexityScore` times `changeWeight`. Each of them breaks a tie by cognitive complexity, nesting, cyclomatic complexity, length and path, skipping a metric already used as the primary key.
3. Each function gets a percentile per metric within the repository, among units measured the same way (same layer, tests apart from production code). A row carries its percentiles whatever the order.
4. When history is available (the shared history cache, which this plugin can refresh itself), the file's change frequency weights the percentile: `changeWeightedScore` is `complexityScore` times `changeWeight`, the percentile of `fileRevisions` among the files that changed. Complexity in code that never changed in the window has weight 0. The weight is the file's, not the function's, and the column is named `fileRevisions` so that it is not read as the function's own count. `analyse --with-fixes` adds `unitRevisions`, the function's own count from function-level history (see Per-function fix statistics).
5. `score` is the primary sort key: the metric's value, `complexityScore` or `changeWeightedScore`. `inputs.by` and `ranking.by` name the order, `ranking.sortedBy` lists the keys in order, and a table run prints a `Notice: sorted by ...` line with the same keys. `ranking.changeWeighted` is true only for `--by change-weighted`. Every row carries both percentile scores when history is available, and `ranking.changeWeightsAvailable` says whether it was. `--by change-weighted` without history, with `changeWeighting` off or in a shallow clone, exits with 2 and says why, because CodeScene prioritises by change frequency times low code health and an unweighted list answers a different question. Output is the top N by the chosen order with the count of the units left out.

### Test code

Every unit and file has a `role`, `production` or `test`. A file is a test when its language's naming conventions say so, or when the shared `testPatterns` of `code-health.json` (see [suite.md](suite.md#configuration)) say so. The conventions are in the language adapters: Go `*_test.go`; C# `*Test.cs`, `*Tests.cs`, and files in a `*.Tests` or `*.Test` project folder; Python `test_*.py` and `*_test.py`; TypeScript and JavaScript `*.test.*`, `*.spec.*` and `__tests__/`; Java and Kotlin `src/test/` and the `*Test`, `*Tests`, `*IT` and `*Spec` class names; Rust `tests/`; C and C++ files under `tests/` or `test/` and `*_test.cpp` or `*Test.cpp`; and, for any other file, a folder named `test`, `tests`, `__tests__` or `__mocks__`. A Rust function in a `#[cfg(test)]` module, or marked `#[test]`, is a test whatever its file. `testPatterns` is a list of globs laid over the conventions: a match makes a file a test, an entry that starts with `!` makes it production, and the last matching entry wins.

`analyse`, `fixes` and `depth` list production rows by default, put the tests in a `tests` section of the JSON (`count`, `listed`, `omitted` and the first ten rows in the same order), and print a notice with the count in a table run. `files` lists production files and counts the test files in `dropped.tests`. `--include-tests` puts the tests in the one list, each row with its role, and the run has no `tests` section. Tests are ranked by percentile among themselves, so a test never moves a production percentile. `complexity.analyseTests` (default true) set to false leaves test files out of the analysis altogether, counted in `skippedFiles.tests`. The `complexity.files` report holds every file with its role, because cochange reads a complexity for each file it ranks.

The `files` rows carry `complexity`, the file's indentation complexity (the definition cochange shares), and `score`, equal to it so that the default order is by complexity. They also carry `functions`, `aboveGuideline` (the count of units above a guideline), `source`, `profile`, `role` and `codeLines`. A file-level value defined differently from the per-function metrics is a proxy, and `source` says so.

| Command | Output |
|---|---|
| `complexity analyse [PATHS] [--metrics m1,m2] [--layer auto\|lexical\|structural] [--by cognitive\|max-percentile\|change-weighted\|METRIC] [--include-tests] [--with-fixes] [--limit N]` | Production functions ranked by cognitive complexity, then nesting, cyclomatic complexity, length and path (`--by` picks another order, see [Ranking](#ranking)), with all selected metrics, percentiles, both percentile scores, `fileRevisions`, change weight, `role` and labels, a count of the functions left out by the limit, and a `tests` section counting the test functions left out (`--include-tests` lists them in the same list). `--with-fixes` adds `fixCommits`, `unitRevisions` and `fixShare` per function from the computation of `complexity fixes`, and its header under `fixes`. Exits with 0 whatever the values. A run on a clean tree stores its result for each combination of options and prints the stored one when it matches, except with `--with-fixes`, and except when the change weights could not be read from the history (a shallow clone), because the same commit may allow them later; `--no-cache` computes it again. Its header has `parseCoverage`: the files a grammar read (`parsedFiles`), how many of them have syntax errors and their share, against the `syntaxErrorPercent` guideline. A table run prints a notice when the share is above it. A file with syntax errors keeps the units the parser recovered and is listed in `filesWithSyntaxErrors`. The C++ adapter repairs the constructs its grammar rejects before it reads a file (test-framework macros that take a block, braced default arguments with no type and pointers to members), each by overwriting characters with as many characters, so line numbers do not move. A test macro such as doctest's `TEST_CASE("name") { ... }` becomes a function unit named from the invocation's text (see suite.md); an enum with a base and no name and a calling-convention macro between a return type and a name are not repaired. |
| `complexity files [PATHS] [--include-tests]` | File-level aggregates of the production code files (those a language adapter or lexical profile claims); `dropped.nonCode` counts the others and `dropped.tests` the test files left out. A run on a clean tree stores its result, which holds every file with its `role`, tests included, and prints the stored one when it matches; the whole-repository run is the `complexity.files` report that other plugins read. `--no-cache` computes it again ([suite.md](suite.md#shared-caches)). |
| `complexity diff BASE[..HEAD]` | Only units added or changed between two revisions, with before and after values. Without HEAD, compares against the working tree. |
| `complexity check [--base REV]` | Compares units against a base revision (default: the merge base with the configured main branch). This is a gate the user chooses to run, so it is the one command that exits with 1: when a new unit is above a guideline, or an existing unit is above a guideline and worsened by more than the configured delta (default 0, so any rise counts). Only cyclomatic, cognitive, nesting and parameters count. Length and the bumpy road do not. A unit that stays under its guidelines never makes it exit with 1, which matches CodeScene gating on a regression and not on absolute values. Built for CI and pre-commit. |
| `complexity explain UNIT` | Line-by-line breakdown of where each increment came from. Lets the agent target the exact construct. Stored by the file's content, so an unchanged file is not parsed again; `--no-cache` breaks it down again. |
| `complexity fixes [PATHS] [--include-tests] [--max-commits N] [--evidence N]` | Per-function fix statistics over the history window, from the fix definition shared with the rest of the suite. See [Per-function fix statistics](#per-function-fix-statistics). Never stored as a report. |
| `complexity depth [PATHS] [--include-tests]` | Exported functions, classes and modules by interface depth, exported pass-throughs first, with labels and `role`. A pass-through that is not exported has no row and is counted in `summary.passThroughNotExported`. The tests are counted in a `tests` section unless `--include-tests` is given. A full run writes the `complexity.depth` report. |

## Per-function fix statistics

`complexity fixes` answers "which functions do the bug fixes keep changing?" in the manner of CodeScene's X-Ray. It uses the fix definition shared by the suite, `history/fix-commits`, configured by `history.fixPatterns`, `history.fixExcludePatterns`, `history.revertPatterns` and `history.fixMatchBody` (see [suite.md](suite.md#configuration)), so its counts agree with the fix rate of `outcome` and the fix factors of cochange.

**Computation.**

1. The window is `windowMonths` back from HEAD's commit date, over the logical changes that survive the shared noise filters. A change with more files than `maxChangesetSize` is skipped and counted, because one edit to hundreds of files says nothing about any function.
2. For each logical change that touched a file with a structural adapter, the lines changed in the new revision come from `git diff -U0` against the first parent of each commit. The new revision of the file is read by blob and parsed through the parse cache, keyed by blob, so a rerun parses nothing it parsed before.
3. Each changed range is mapped onto the functions and methods that contain it. A function nested in another owns its own lines, and the function around it owns the rest, so one edit counts once. A deletion counts for the function that holds the lines on both sides of it. A changed line outside every function counts against the file (`outsideUnits`), never against a function. A file created by a commit counts as one revision of each of its functions, and never as a fix.
4. Each function is followed forward to the current revision with the matcher of `check` and `diff`: by identity, with the earlier revision given the current path so a file renamed in git keeps its functions, then by body similarity (`moveSimilarity`) so a function renamed inside its file keeps its history. A function that is gone follows its later self in the file's latest analysed revision, so a rename before its deletion keeps its history. A function moved to a different file is not followed across files, so its history splits.
5. A logical change is a fix when one of its commits matches the shared definition. A revert is not a fix, and neither is a change whose fix pattern match is removed by `history.fixExcludePatterns`: it is counted under `fixesExcluded`, by the excluding pattern. A function's `fixCommits` is the fix changes with a changed line in it, `unitRevisions` is every change with one, and `fixShare` is the first over the second. `unitRevisions` is the function's own count, where `fileRevisions` in `analyse` is its file's.

**Output.** Rows are the current functions with at least one fix, sorted by `fixCommits`, then functions with at least `fixes.minRevisions` revisions (default 3, a judgement call not calibrated on a corpus) before the rest, then `fixShare`. A row with fewer revisions is labelled `low evidence` in `labels`, because one fix in two revisions is a share of 0.5 on almost no history. A row carries the unit id, file, `fixCommits`, `unitRevisions`, `fixShare`, the function's current cognitive complexity, `earlierIds` for a rename or a move, and the evidence commits (`sha`, `date`, `subject`, the matched `pattern`, and whether it matched in the subject or the body) newest first up to `--evidence`, with `evidenceOmitted` for the rest. Functions that no longer exist are listed apart under `deleted`, counted whatever the limit, with their own rows up to a stated limit and the omitted count. `outsideUnits` lists the files with fixes outside every function, with the same limit and count: its `fixCommits` is the distinct fix changes with a changed line outside every function, so it never exceeds the fixes of the window, and `fixFileChanges` is the sum over the listed files, where one change touching three files counts three times. `summary` counts every function the window touched, so the rows are visibly a part of it.

**Header.** `fixConvention` is the repository-level check over every logical change of the window, as in `outcome`, with the same note when the share is under 2 percent or over 60 percent or there are fewer than 30 changes. `commits` says how many commits the selected files had in the window, how many were analysed and how many skipped, by cause: older than `--max-commits`, in oversized changes, or touching no file with a structural adapter. `fixesExcluded` counts the changes that a fix pattern matched and an exclude pattern removed, by excluding pattern, with the first of them. `lowEvidence` states the revision guideline. `files` counts the file revisions analysed and those that could not be mapped, by cause. `cache` counts blobs parsed and blobs read from the cache. `shallow` says whether history before a shallow clone's boundary is missing. A table run prints the same facts as notices.

**Cost.** The run parses the historical revisions of the files the window touched, so it is bounded explicitly: by the window, and by `--max-commits N` (default `fixes.maxCommits`, null, which analyses every commit of the window), which analyses the newest N commits first and reports what it left out, in the header and as the first notice of a table run, because a bounded run covers part of the window. `--max-commits all` restores the whole window over a configured bound. A rerun parses nothing it parsed before. Each distinct blob is parsed once, through the shared parse cache, with the grammars loaded once per run.

**`analyse --with-fixes`** runs the same computation and joins it to the ranked rows by function id. A function no analysed change touched has `fixCommits` 0, `unitRevisions` 0 and a null `fixShare`. A run with `--with-fixes` is never stored as the `complexity.analyse` report.

The figures are guidelines for where to look. A function that is the extension point of a system changes and is fixed often because it is used often, and a function with no fix may have fixes that nobody labelled when `fixConvention.note` is set.

## Agent integration

### On-request explanation

The skill tells the agent to run `complexity explain FILE#UNIT` on a function before it changes it, and `complexity check` before it commits work that adds or changes functions. This is the cheapest point to fix complexity: the agent has the code in context and has not yet built on it.

## Skill guidance

The skill holds the remedy policy, which is the main point of the plugin:

1. **Locate the cost.** Run `explain` and find which constructs contribute. Name the red flag, usually *nonobvious code*, *special-general mixture* or *shallow module*.
2. **Prefer simplification that deletes.** Guard clauses instead of nested `if`, removing dead or impossible branches, replacing flags with separate call paths at the caller, table-driven dispatch, defining error cases out of existence, and standard-library constructs.
3. **Prefer deepening over splitting.** If a function must be split, the extracted part must be a deep, well-named unit that hides a decision. It stays in the same file and is module-private unless evidence says otherwise. This keeps the complexity plugin from creating the distant, single-use helpers the locality plugin exists to remove.
4. **Never game the metric.** Moving conditionals into lookup objects that encode the same branching, or splitting a function purely to pass a guideline, counts as a regression in review.
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

- Enabled metrics and the guideline of each metric (`guidelines`), with optional per-glob overrides (generated code, tests). Guidelines are configurable because they are defaults for investigation, and a repository that disagrees changes them.
- Shared history settings that the change weighting and `outcome` read, from the top-level `history` section of the suite config ([suite.md](suite.md#configuration)), overridable here under the same names: `windowMonths` (default 12), `maxChangesetSize` and `botPatterns`.
- Cyclomatic `switch` mode.
- Base revision for `check`, and the worsening delta `check` and `diff` share.
- The agreement bar for per-function lexical metrics.
- The shallow guideline of the interface depth label (`interfaceDepth.shallow`).
- The defaults of `--max-commits` and `--evidence` for the fix statistics (`fixes.maxCommits`, `fixes.evidence`), and `fixes.minRevisions`.
- Whether tests are analysed (`analyseTests`, default: analysed, ranked separately and listed after the production code), and which files are tests (the shared `testPatterns`).

## Languages

The plugin supports every supported language of the suite (tier 1: TypeScript/JavaScript, C#, C++. Tier 2: Python, Go, Java, Kotlin, Rust) through tree-sitter adapters (see [suite.md](suite.md#languages)), and each language's readings of the shared definitions are in suite.md under "Metric definitions per language". An adapter provides a construct map for function units, decision points, nesting structures, boolean-operator sequences and parameters, which the shared metric engine reads, and must pass the shared metric conformance fixtures before it is listed as supported. Where a language's constructs differ from the shared definitions, the plugin keeps one file for the language that says so in `complexity explain`.

## Decisions

- **One plugin, pluggable metrics**, for the reasons above.
- **Cognitive complexity follows the SonarSource specification exactly**, so results can be compared with a widely used tool and the definition is not re-litigated.
- **Guidelines, not hard limits.** Values from CodeScene and the literature order and annotate results. They do not hide or fail them, except in `check`, which the user runs as a gate.
- **Defect fix.** The outcome comparison and cochange's risk factors share one definition of a fix commit (`history/fix-commits`, configured by `history.fixPatterns`, `history.fixExcludePatterns`, `history.revertPatterns` and `history.fixMatchBody`; see [suite.md](suite.md#configuration)), because two definitions in one suite give inconsistent outcomes. The patterns are matched against the commit subject and are a judgement call, so some matches are not defects: `changeCost.*.fixCommits` keeps every matching commit, with the pattern that matched it, up to a limit it reports the omissions of. A revert is not a fix. `fixConvention` is the repository-level check over every logical change in the two windows. It carries a note when fixes are under 2 percent or over 60 percent of them, or there are fewer than 30, and says the commit messages probably do not follow a convention this can use. `complexity` may override these keys in its own section. The comparison group is unchanged files with functions, matched one to one by the highest pre-change metric percentile.
- **Ratchet, not gate.** A hard limit on an existing codebase produces a backlog nobody burns down, or a blanket waiver. The ratchet compares against a base revision, not a committed baseline file: a file holding every unit's values would conflict on every merge, and the blob-keyed parse cache makes the base revision cheap to measure.
- **No length guideline**, following Ousterhout's argument against shallow decomposition.

## Open questions

- Whether a function moved to another file should be followed across files in `complexity fixes`, which costs a comparison of every unmatched function against every function that appeared in the same commit.
- Whether symbol-level co-change, from mapping diff hunks onto function ranges, belongs here (this plugin already parses) or in cochange.
- Whether Rust's wildcard `match` arm should stop counting as a case, for consistency with the other languages.
- Whether `complexity depth` rows should rank by a corpus-calibrated figure instead of the judgement-call guideline.

## Milestones

1. Lexical layer: C-family and indentation profiles, function blocks, indentation complexity, bumpy road, keyword complexity, with fixtures in several languages. File-level metrics ship first. Per-function lexical metrics wait for the agreement test in milestone 2.
2. Language adapter for TypeScript; cyclomatic, cognitive, nesting, length and parameters with conformance fixtures, and the lexical agreement test against it.
3. `analyse`, `files` and `explain` with JSON schemas.
4. `check` and `diff` against a base revision, for CI.
5. Skill remedy policy and plugin packaging.
6. Change-weighted ranking from the shared history cache.
7. Interface depth and pass-through signals.
8. C#, then C++, then the tier-2 languages.
