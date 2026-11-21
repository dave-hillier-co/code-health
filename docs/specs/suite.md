# Code Health Suite — Spec

This spec covers the conventions shared by every plugin in this marketplace. Each plugin spec ([locality](locality.md), [cochange](cochange.md) with its [abandonment](abandonment.md), [identities](identities.md) and [change-risk](change-risk.md) skills, [complexity](complexity.md), [structure](structure.md) with its [packaging](packaging.md) skill) assumes this one, and [red-flags.md](../../shared/red-flags.md) is the shared design vocabulary.

## Purpose

The suite is a set of Claude Code plugins that find where code is expensive to change, guide agents in fixing it, and measure whether changes really got cheaper. Each plugin pairs a deterministic CLI that computes facts with a skill that holds policy and judgement.

## Applicability

The suite is built for **medium to large monolithic codebases**: single applications, modular monoliths and monorepos where the code that changes together lives in one repository and depends through imports, includes or references. That is where distance, cohesion and co-change carry signal, and where an agent's navigation cost grows with size.

It is a poor fit for **microservice estates**. In a repository per service, each repository is small, so locality is trivially satisfied, and the coupling that matters crosses services through APIs, messages and shared schemas. No import graph or single history shows it. That needs different tools (contract and schema analysis, cross-repository co-change, tracing), outside this suite.

**Maturity strengthens the evidence.** History-based signals (co-change, hotspots, abandonment, change stability, grace periods) need history. A mature codebase, with years of commits, many contributors and many logical changes per file, gives strong co-change evidence. A young one gives weak evidence: a few shared commits are indistinguishable from chance, and much of the code has not yet had time to be reused. Plugins therefore measure evidence strength and report it (see [Evidence strength](#evidence-strength)). On young codebases, static signals carry the recommendations and history-based ones are labelled tentative.

Monorepos that hold several services sit in between. Each service's package boundary is a fixed point that no move crosses. The plugins work within each service. Cochange still sees across them, and frequent co-change between services is reported as evidence of a distributed monolith. Fixing that is outside the suite.

## Principles

These apply to every plugin, and a plugin spec that departs from one must say why.

1. **Outcomes over scores.** Every plugin names an outcome measure (change spread, change cost, agent effort) and treats its own static score as a leading indicator only. Any score that is optimised alone gets gamed, so each plugin also names its gaming check.
2. **Determinism where mechanical, judgement where semantic.** The CLI computes facts and deterministic recommendations, so the same inputs (repo, config and history, plus any extras the output declares, see [CLI contract](#cli-contract)) produce byte-identical JSON. The agent supplies judgement and records every override with a reason.
3. **CLIs report, they do not edit.** Analysis commands never modify code. Mechanical edit commands (such as the locality mover) are separate, default to a dry run, and need `--apply`.
4. **One refactoring per commit.** Every applied change is a single, revertible step with tests green before and after. A reviewer never evaluates a move and a behaviour change together.
5. **Evidence beats convention.** Folder conventions, anticipated reuse and metric thresholds are hypotheses. History and consumer evidence decide. The rule of three marks when to *consider* removing duplication or keeping an abstraction. It is never a mechanical rule in either direction.
6. **Deep over shallow, and inline by default.** Remedies hide decisions behind simple interfaces. Inlining single-use indirection is a first-class remedy (Carmack, Blow). No plugin creates new shared helpers or abstractions, and any extraction stays local (see [red-flags.md](../../shared/red-flags.md)). The one stated exception is dependency breaking in [structure](structure.md#decisions).
7. **Scrutinise what is widely used.** High fan-in multiplies the cost of every flaw. Utilities with many consumers have earned their location, and they are the first place to check for red flags.
8. **Built for agents, usable by people.** Output is compact, ranked and limited by default. JSON is the contract, and a human-readable table is the default view in a terminal.
9. **Local and private.** No network access, no telemetry. Data about people is off by default. The exceptions (identity resolution, successor names, an author's placement to their own change) are stated and bounded in their own specs.
10. **Self-contained plugins, composed by data.** No plugin requires another at runtime. They share code at build time and exchange results through files.
11. **Patterns emerge from the codebase.** Where a remedy involves a design mechanism (an interface, events, a mediator), skills prefer what the codebase already uses nearby and ask before introducing anything new. No skill defaults to a named pattern. CLIs provide the census of what exists; the agent chooses.
12. **Language-agnostic first.** As much as possible works from history, indentation and lexical structure, which apply to every language and every historical revision. Language adapters add precision where the agnostic layer cannot answer: import resolution, exact metric definitions, deterministic moves. The lexical layer is the lowest common denominator, and language support beyond it is best effort: a repository in a language with no adapter still gets the history layer and whatever the lexical layer can measure.

## Repository layout

The repository is both the marketplace and the source monorepo.

```
.claude-plugin/marketplace.json     marketplace manifest
plugins/                            what users install; one self-contained folder each
  <plugin>/
    .claude-plugin/plugin.json
    skills/<skill>/SKILL.md
    skills/<skill>/references/*.md  loaded on demand (incl. generated red-flags.md)
    hooks/hooks.json                opt-in hooks, if any
    dist/<plugin>.mjs               bundled CLI (built, committed)
    dist/chunk-<hash>.mjs           modules a command imports on demand, only if the plugin has any
    dist/grammars/*.wasm            tree-sitter grammars, only if the plugin parses
    schemas/*.schema.json           JSON Schemas for every --json output
    evals/<case>/                   claude plugin eval cases
packages/                           source; never installed directly
  cli-kit/                          argument parsing, output, exit codes, config loading
  history/                          git ingestion and the shared cache
  lexical/                          lexer profiles, indentation, function blocks, hunk shapes
  parse/                            web-tree-sitter loading and language adapters
  graph/                            import graphs, dominators, tree distance
  <plugin>/                         each plugin's CLI source and tests
shared/red-flags.md                 single source, copied into each skill's references
docs/specs/                         these specs
fixtures/                           scripts that build deterministic fixture repos, and languages/<id>/ conformance fixtures
```

Rules:

- **Installed plugins are copied** to `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`. Nothing outside the plugin folder is copied, and paths that escape it are rejected. Shared code therefore reaches a plugin only by bundling: esbuild bundles each CLI with its `packages/*` dependencies into one ESM file in `dist/`. A module a command loads with `import()` goes in a content-named `chunk-<hash>.mjs` beside it, read only when that command runs, so a large dependency (locality's ts-morph) does not slow every start. Chunks are plain ESM files in the same folder, so there is still no runtime install.
- **`dist/` is committed**, because installation is a git copy with no build step. CI rebuilds every plugin and fails if `dist/` differs from the committed build, so the shipped bundle always matches its source.
- **No runtime npm install.** Bundles have no external dependencies. WASM assets sit next to the bundle and are resolved relative to `import.meta.url`.
- **No `index.ts` barrel files.** Modules are imported by their real path, which keeps the suite's own import graph honest for the locality analyser.
- **No top-level `bin/`.** It would put the CLI on the Bash PATH, but claude.ai and Cowork do not install plugins that contain one. Skills call `node ${CLAUDE_PLUGIN_ROOT}/dist/<plugin>.mjs` instead.
- **Plugin names** are kebab-case and avoid the reserved prefixes (`claude-`, `anthropic-`, `cc-plugin-`).

## Plugin anatomy

### plugin.json

Each plugin's manifest is `name`, `displayName`, `version`, `description`, `author`, `license`, `repository`, `keywords` and `engines.claude-code`. The version is set **in plugin.json only**, never also in the marketplace entry: plugin.json would win there, with only a `claude plugin validate` warning to show for it. Users of a third-party marketplace get updates only when the version string changes, so CI fails a change under `plugins/<plugin>/` that does not bump that plugin's version.

### Skills

- One skill per user question, not per CLI command. Most plugins need one skill. A second is justified when it is triggered by a different situation, such as a pre-change briefing versus a periodic review.
- `SKILL.md` stays under 500 lines and holds the workflow, decision policy and commit discipline. Thresholds and long explanations go in `references/`, loaded on demand. Every line of SKILL.md is a recurring token cost.
- The `description` says when to use the skill in the user's terms ("before refactoring", "code that is hard to change", "what usually changes with this file") and is covered by trigger evals.
- `allowed-tools` pre-approves the plugin's own CLI so runs do not prompt each time: `Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/<plugin>.mjs *)`. It never approves anything broader.
- `${CLAUDE_PLUGIN_ROOT}` is substituted in skill content but is **not** in the environment of Bash commands, so skill text writes the CLI path out in full through substitution and never relies on the variable at runtime.

### Hooks

Hooks are opt-in per repository, because injected context costs tokens. A plugin's hook command reads the repo config and exits silently unless that config enables it. Hook rules:

- Exec form with `${CLAUDE_PLUGIN_ROOT}`, and a hard time budget of a few hundred ms. Every hook run is a fresh process, so the budget covers process start and anything the hook loads.
- A hook never refreshes the history cache and never writes analysis results. It exits 0 on every path, its own errors included. `PostToolUse` runs after the tool, so it could not block the edit in any case.
- **Session state.** The one thing a hook writes is its own state for the session, in `.cache/code-health/sessions/<session_id>.<hook>.json`, one file per plugin hook so that what one hook has said never silences another, keyed by the `session_id` in the hook input: the files edited so far, the files it has already spoken about, and any last measurement. The hook keeps this itself on each edit. It does not read the transcript for it, because the transcript is written asynchronously and can lag.
- **Staleness.** A hook that reads history tolerates a cache up to a configured number of commits behind HEAD, and is silent beyond that. Requiring an exact match would silence it after every commit or pull.
- Context goes back through `hookSpecificOutput.additionalContext` as one short factual sentence, at most once per file per session.

### Configuration

All plugins read one committed file at the repo root, `code-health.json`, with a `$schema` reference. It has a top-level `exclude`, `languages`, `entryPoints`, `components` and `vagueNames` shared by every plugin, and one section per plugin. Each plugin validates its own section and ignores the others. Missing config means defaults. Every CLI has `config explain` to print the effective config and where each value came from, so the skill can explain it. Plugin `userConfig` is not used, because these settings belong to the repository, not the user.

## CLI contract

Every plugin's CLI follows the same conventions, implemented once in `packages/cli-kit`.

- **Invocation.** `node <dist>/<plugin>.mjs <command> [options]`. It needs Node ≥ 22.13 for unflagged `node:sqlite`, and the CLI suppresses its experimental warning.
- **Output.** A table on a TTY. JSON with `--json`, or whenever stdout is not a TTY. Every JSON document has `schemaVersion`, `tool`, `command`, `repo` (HEAD SHA and dirty flag), `config` (hash of effective config), `inputs`, `results`, `truncated` and `meta`. Wall-clock timestamps, timings and the git version appear only in `meta`, which golden comparisons ignore, so outputs stay diffable.
- **Determinism.** Results are sorted by score, then by path. Paths are repo-relative POSIX. Floats are rounded to a fixed precision. Golden tests enforce byte-identical output. Time is anchored to HEAD's committer date, never the wall clock: analysis windows, code age, grace periods and activity windows are all measured back from it. Anything a result depends on beyond the repo, config and history (a sibling plugin's report, local overrides, session transcripts) is named in `inputs` with its stamp or hash, and byte-identical output is promised for identical inputs.
- **Size discipline.** List commands default to `--limit 20`, take `--fields` to project columns, and report how many results were cut. An agent should never receive a 5,000-row dump by accident.
- **Exit codes.** 0 success; 1 check failed (findings over threshold or regression); 2 usage or config error; 3 environment error (not a git repo, shallow clone without a window, Node too old). Errors are JSON on stderr when `--json` is set.
- **Schemas.** Each output has a JSON Schema in `schemas/`. A breaking change bumps `schemaVersion` and the plugin's major version.
- **Self-description.** `--help` on every command, `explain <rule>` for every recommendation rule, and `config explain`.

## Shared vocabulary

- **Path**: repo-relative POSIX path.
- **Symbol id**: `path#Qualified.name`, with `~n` for duplicate names in one scope.
- **Tree distance**: `d(a, b) = depth(a) + depth(b) − 2·depth(LCA(a, b))` over folders, with files at their folder's depth. Every plugin uses this one function.
- **Component**: a named group of paths from the optional `components` globs in config.
- **Consumer**: a file or symbol that references a unit, classified as a direct call, another reference (value, registration, decorator) or a test reference.
- **Fan-in**: the number of distinct consumer files.

## Evidence strength

Every output that uses history includes an `evidence` block, so neither the agent nor the user mistakes a sparse history for a strong signal:

- **Repository level**: months of usable history, logical changes in the window, active contributors, and a grade (`strong`, `moderate`, `weak`) from configurable thresholds.
- **Per finding**: the support behind it (shared changes, revisions per side), and whether it clears the minimum for its grade.

Usable history excludes:

- **Imported history**: a repository migrated from another VCS, or started with a bulk "initial import" commit, has a history that begins mid-life. A first commit adding a large share of the current tree is detected, and the window starts after it.
- **Shallow clones**, detected and reported as truncated.
- **Merge-policy changes** (moving to or from squash merges). They are not excluded, but each policy changes what a commit means, so a shift in the median commit size is reported, and the agent may choose a window within one policy.

Skills use the grade. With `weak` evidence they rely on static signals, present history-based findings as tentative, and do not let co-change overturn a static recommendation. With `strong` evidence, co-change wins where it disagrees with static structure, as each plugin spec says.

## Shared caches

- Location: `.cache/code-health/` at the repo root. On first use the CLI writes `.cache/code-health/.gitignore` containing `*`, so nothing needs adding to the repo's own `.gitignore`. Nothing is ever written inside the plugin folder, which is replaced on update. Everything in the cache can be regenerated, so clearing it costs time and nothing else.
- `history.sqlite`: commits keyed by SHA, each with its changed paths, numstat and renames. It is maintained by the `history` package and bundled into every plugin that reads history, so any of them can refresh it. Commits are immutable, so stored rows are never invalidated. A refresh adds the commits reachable from the analysed ref that are not yet stored, and every query selects by reachability from that ref. Switching branches or rewriting history costs only the commits that are new. A schema version number triggers a rebuild on mismatch, and a write lock makes concurrent refreshes safe.
- `blame.sqlite`: line authorship, the commit behind each line range of each file, per path and blob. It is kept apart from `history.sqlite`, has its own schema version and write lock, and is maintained by the `history` package for abandonment and change risk. A stored blame is reused while the file's blob is unchanged and no commit since it was made has touched the path, so a refresh blames only changed files. It holds no identities: the mailmap and identity decisions are applied when it is read, so changing either never needs a re-blame. See [abandonment.md](abandonment.md#concepts).
- `parse/`: parse results keyed by git blob SHA and grammar version. Unchanged files are never re-parsed, and historical revisions can be analysed by blob.
- `reports/<plugin>.<command>.json`: the complete result of a command's last full run, stamped with the HEAD SHA and config hash it was computed from. A report is written only by a run over the whole repository on a clean tree, and it holds every result: `--limit`, `--fields` and path arguments change what is printed, never what is stored. This is the composition seam. A plugin may read another's report when its stamp matches the current HEAD. It names the report in `inputs`, and it must work without it. Reads run one way only (cochange reads complexity and locality, structure reads locality), so no result depends on the order the plugins were run in.
- **Worktrees.** `history.sqlite` and `parse/` are content-addressed, so linked worktrees share the main worktree's copies. Reports and hook session state are per worktree.

### Local state

State that cannot be regenerated never goes in the cache. It lives in `.code-health/local/` at the repo root, which the CLI creates with its own `.gitignore` containing `*`: activity overrides, a local-only mailmap and identity decisions, and measurement baselines. Files a team chooses to share, such as committed identity decisions, sit beside it in `.code-health/`.

## Languages

### Analysis layers

Every plugin's analysis is built in three layers. Each one works without the layers above it.

| Layer | Input | Works for | Provides |
|---|---|---|---|
| **History** | git log, numstat, blame | Every file, every language | Co-change, hotspots, spread, age, abandonment, identities, change stability, hidden coupling, change magnets |
| **Lexical** | Indentation, plus an optional per-family lexer profile: comment and string delimiters, block style (braces or indentation) and a branch-keyword list | Any text file and any historical blob, at best effort: indentation metrics always, profile metrics where a profile fits | Indentation complexity, bumpy road, nesting, approximate function blocks and their length, keyword complexity, append-shaped edits, lexical duplication |
| **Structural** | Tree-sitter grammar plus a language adapter | Tier 1 and tier 2 languages | Exact units and metric definitions, import and symbol resolution, dominator units, census, deterministic moves |

The lexical layer is the lowest common denominator. Its indentation metrics (indentation complexity, nesting, length) need no profile and apply to any text file. Lexer profiles are data, not code, and add comment and string stripping, keyword complexity, approximate function blocks and the per-function metrics built on them. A C-family profile covers C++, C#, Java, Kotlin, JavaScript, TypeScript, Go and Rust, and an indentation profile covers Python. Other languages can be mapped to a profile in config, but nothing outside tier 1 and 2 is tested or promised.

Lexical values are approximations, offered at best effort and labelled as such. A language gets whatever the layer can measure for it, and the output says what was skipped.

For tier 1 and 2 languages the structural layer checks the lexical one (see [Testing](#testing)). Per-function lexical metrics are reported for a language only when its measured agreement clears the configured bar, and the agreement rate travels with them. Below the bar, and for files with no profile, the layer reports file-level metrics only. A language mapped to a profile by config has no measurement behind it, so its per-function values are marked `unverified`.

Every output says which layer produced each value (`source: history | lexical | structural`). When the structural layer is available it wins, and the lexical value can be shown alongside for comparison. The lexical layer is also what makes history-wide analysis affordable: trends over hundreds of past revisions run on the lexical layer, without parsing any of them.

### Tiers

Tree-sitter WASM grammars run through `web-tree-sitter`, with no native builds. A plugin ships the grammars for every supported language and loads only those present in the repository.

| Tier | Languages | Support |
|---|---|---|
| **1** | TypeScript/JavaScript, C#, C++ | All three layers, with full adapters for every plugin |
| **2** | Python, Go, Java, Kotlin, Rust | Next, in roughly that order. Java and Kotlin share one JVM graph, so mixed projects resolve across both. |
| **0** | Everything else | History layer, plus best-effort lexical metrics: indentation metrics always, profile metrics only if the language is mapped to a profile. No deterministic moves and no import-graph units. |

Within tier 1 the build order is TypeScript, then C#, then C++, from easiest to hardest resolution. TypeScript also has a mature codemod (ts-morph) for deterministic moves.

An adapter is listed as supported only when it passes the shared conformance fixtures for every plugin that uses it. A language is one adapter behind one contract, registered by one line, with one file per language in each plugin that has language-specific tables, so adding a language does not edit a shared module (see CONTRIBUTING.md, "Adding a language").

### Dependency models

A language adapter turns source into file and symbol dependencies. Languages differ in how dependencies are written, so adapters work in one of two modes, and the graph package consumes both the same way.

- **Import-based**: a statement names a file or module (TypeScript, Python, Rust `mod`/`use`). The resolver maps specifiers to files.
- **Symbol-based**: a statement brings in a namespace, or nothing at all (C# `using`, Java, Kotlin and Go same-package references, C++ declarations visible through headers). The adapter builds a table of declared types and members per file, then resolves referenced identifiers against it to derive file edges. The resolution is heuristic: it follows names without overload or template resolution, so it is good enough for ranking. Before any move, references are confirmed with the language's LSP server.

### Language notes

| Language | Resolution | Boundaries (fixed points) | Moves | Notes |
|---|---|---|---|---|
| TypeScript/JavaScript | tsconfig `paths`, package `exports`, barrels followed through | Workspace packages | ts-morph | Dynamic `import()` and framework file conventions need configured entry points |
| C# | Symbol-based over `using` and namespaces. A file resolves names within its own project and the projects it references, directly or not, and a `global using` applies to every file of its project. Partial classes merge into one unit across files: the parts depend on one another, and uses of the type land on the part in the file named for it. | Projects (`.csproj` and their references), solutions | File move only. The namespace is left alone, so the move commit changes no names. SDK-style projects glob sources, so no project edit is needed. Confirm with the Roslyn LSP. Updating the namespace to match the folder is a separate, optional commit, because reflection, serialisation, XAML and DI-by-name can all see it, and for a library it is a public API change. That step renames only a namespace the move vacates, and reports every other. A project that lists a moved file as a `<Compile>` item is the only text a move rewrites. | Namespace and folder can disagree. Distance uses folders, because agents navigate files. |
| C++ | `#include` resolved with include paths from `compile_commands.json`. A header and its source file form one unit: one edge from the header to the source file stands for the pair, so they move together and the include every pair has is not a cycle. Where there is no `compile_commands.json`, the include directories of `target_include_directories` and the public ones of linked targets stand in, and the repository root is tried last. Symbol-based for calls, resolved against the declarations visible through the headers a file includes, directly or not. | Build targets (CMake targets, and other build systems by config) | Move plus rewriting `#include` paths and target source lists. There is no mature codemod, so the agent performs the build-file edits and clangd confirms references. | The preprocessor is not run. Conditional compilation is parsed as written, and macro-generated code is invisible, which is reported per file (`filesWithMacroCode`). A lambda bound to a name is a unit, and `goto` costs a flat 1 in cognitive complexity. |
| Python | Package roots found from the layout of the tree (the repository root, a `src/` layout, a script's own folder), the importing file's own root first. `__init__.py` re-exports and star imports are followed to the definition, and a name imported from a package that is one of its modules (`from package import module`) resolves to that module. | Distribution packages (`pyproject.toml`) | Each import is respelled to reach the same file from where the importing file now is: relative stays relative, absolute stays absolute. rope, when installed, makes the same move on a copy and confirms that every import reaches the same file. | Dynamic imports (`importlib.import_module`, `__import__`) need configured entry points, and a moved module named in a string is a warning, not a rewrite. Implicit namespace packages are walked through but are not themselves a file to depend on. |
| Java / Kotlin | Packages map to folders; symbol-based within a package. A file sees its own package and what it imports: an import names one type (or a package, with `*`), `import ... as` is followed, and a parent package is not in scope. | Gradle and Maven modules | The mover rewrites the package clause, every import the new folder changes and the imports that cross-package visibility now needs, with the language server (jdtls, Kotlin LSP) confirming references when installed | One graph across both languages. A package that does not match its folder is kept as written and the move is a file move. Kotlin top-level functions reach Java through a file facade class (`FooKt`) that the graph does not see, and a method call is resolved by the type that declares it, not by overload. Java switch labels count once however many values they list, lambdas are nested functions, and Kotlin `when`, `if` expressions and elvis follow the Kotlin notes below. |
| Go | Import paths resolved against the module path in `go.mod` (and `go.work`) to a package directory, then symbol-based within the package, since files in one directory share a package without importing each other | Modules (`go.mod`), and `internal/` directories, which the compiler restricts to their parent tree | Moving a file within its directory changes nothing. Moving it to another directory changes its package, so the move rewrites the package clause and every qualified reference, and is not a pure move. Package renames go through gopls. Other moves are performed by the agent, with gopls confirming references. | Build constraints (`//go:build`) are parsed as written, like the C++ preprocessor. Generated files (the standard `// Code generated … DO NOT EDIT.` header) are excluded by default. Methods are followed through their own receiver only, since a call on another value needs types, and a blank import links to the files of its package that have an `init` function. |
| Rust | `mod` tree and `use` paths | Crates and Cargo workspaces | rust-analyzer | The module tree is explicit, so resolution is precise |

### Metric definitions per language

The complexity plugin's conformance fixtures pin down per-language constructs: C# switch expressions, pattern combinators and `??=`; C++ lambdas and `goto`, with preprocessor branches not counted; Kotlin `when`, with elvis not counted (it is null-coalescing); Python `elif` and `match`, with `case _` and `not` not counted and each comprehension `for` and `if` clause counted for cyclomatic only; Rust `match` and `if let`, with `?` not counted; Go `switch`, type switches and `select`, with `if err != nil` counted as an ordinary `if` and `defer` and `go` statements not counted. Each language follows the cognitive complexity specification's rules for its constructs.

## Testing

The testing style is classic TDD with sociable tests. Mocks are reserved for process boundaries.

- **Fixture repositories.** Scripts in `fixtures/` build real git repositories in temp directories with fixed author and committer dates, so their histories are reproducible. Tests run the real CLI against them. There are no mocked git or parser layers.
- **Golden outputs.** JSON output per fixture is compared byte for byte. An intentional change updates the golden file in the same commit.
- **Algorithm properties.** Graph algorithms (dominators, LCA, coupling) are checked against naive reference implementations on generated graphs. For dominators, the reference is the textbook iterative data-flow method: *d* dominates *n* exactly when removing *d* disconnects *n* from the root. SCC condensation is checked by confirming that no unit splits a cycle.
- **Conformance fixtures.** Each language keeps small source fixtures with hand-verified expected values in `fixtures/languages/<id>/`, one folder per area: the adapter's units and dependency edges, each metric, interface shape, census mechanisms, packages and boundary findings, and file moves. Every plugin that uses the adapter runs the areas it owns, and a language is supported only when they all pass. Suites that need an external tool skip with a notice when it is not installed.
- **Lexical agreement.** Tier 1 and 2 languages have both layers, so the structural layer is ground truth for the lexical one. A corpus per language (the adapter and metric fixtures, plus files with the awkward shapes: lambdas, nested classes, expression-bodied functions, C++ macros and templates) runs through both, and lexical function blocks are matched to structural units by start and end line. The result is an agreement rate per profile and language: units found, units with exact boundaries, and spurious blocks. The rates are recorded in the repository, one file per language, and checked in CI, so a profile change cannot make them worse unnoticed. They decide where per-function lexical metrics are reported (see [Analysis layers](#analysis-layers)).
- **Skill evals.** `claude plugin eval` cases in each plugin's `evals/` cover triggering (the skill loads on relevant prompts and not on unrelated ones) and behaviour (it runs the CLI, respects grace periods and commit discipline, and cites red flags). The model and judge model are pinned explicitly (neither is by default), and a cost ceiling is set. Evals run on demand and before release, not on every push, because each run is billed.
- **Validation.** `claude plugin validate --strict` runs on the marketplace and every plugin in CI.

## Release

- Each plugin is versioned with semver independently. A breaking JSON schema change is a major bump, and a change in recommendation output for the same input is at least a minor bump, called out in the changelog.
- CI gates: build reproducibility, the version-bump check, the full test suite, plugin validation and schema checks of the golden outputs.
- Team adoption: commit `extraKnownMarketplaces` and `enabledPlugins` in the project's `.claude/settings.json`, then each collaborator runs `claude plugin install <plugin>@code-health --scope project` once per clone.

## Measurement across the suite

Each plugin defines its own outcome measure, and the suite shares the instruments:

- **Change spread** (from the history cache): mean pairwise tree distance of files per logical change. Each file is placed at its path as of that change, so a later move never rewrites the spread of earlier changes.
- **Agent effort** (from Claude Code session transcripts in `~/.claude/projects/`): files read, distinct folders visited, re-reads and tokens per task. A task is one user prompt and the agent turns that follow it, up to the next prompt, and tasks with no edits are left out. The transcript format is internal to Claude Code and can change, so one module reads it, and a version it does not recognise is reported as not measured. Only paths and counts are extracted. Measurement is local by default, and any team aggregation exports counts and repo-relative paths only, never content.
- **Before and after windows**: baseline before the first change, then compare over a matching window afterwards, with the same filters. Reports state sample sizes, and the skill does not claim an effect the data cannot show.
- **Comparison group**: findings are acted on because they are extreme, and extreme values drift back towards the average when left alone. Each comparison therefore sets the acted-on files beside candidates of similar rank that were not acted on, and reports the difference between the two groups, not the raw before and after.
- **The suite's own commits**: refactoring commits made through the skills carry a `Code-Health:` trailer naming the plugin and rule. They are left out of outcome windows, since a move commit is wide by construction.
- **Independence**: a measure that a tool moves by construction is a leading indicator for that tool, whatever it is elsewhere. Change spread falls whenever files that change together are co-located, so for locality the independent outcome is agent effort (see [locality](locality.md#measurement)).

## Build order

Each plugin spec has its own milestones. Across the suite, the order is set by what the measurements need:

1. The history core and `cochange spread`, because every outcome in the suite is measured with them and a baseline cannot be taken afterwards.
2. A premise check, before any mover exists: from existing history and session transcripts, test whether tasks that touch more distant files cost more reads and tokens. Locality's priority depends on the answer.
3. The lexical layer with its agreement test, then the TypeScript adapter.
4. Analysers and baselines for locality and complexity, then the commands that change code.
5. Structure, which builds on locality's graph and cochange's coupling, then its packaging skill.
6. Identities, then abandonment and change risk, which share the blame cache.
7. Further languages, in tier order.

## Roadmap

Candidate plugins, each to get its own spec before work starts:

- **idioms**: replacing thin wrappers and re-implementations with standard-library or platform idioms (out of scope for locality).
- **duplication**: clone detection, reporting only, built on the lexical layer (normalised token windows) so it works in every language. The remedy is judgement, and creating shared helpers needs consumer evidence first.

## Decisions

- **Plugins, CLIs and skills; no MCP servers.** The work is batch-shaped, a CLI is testable and usable in CI, and nothing costs context until a skill calls it.
- **Self-contained bundles over runtime plugin dependencies.** Each plugin installs and works alone. Composition is optional and goes through report files.
- **Committed `dist/`.** Installation copies git content, so the build must be in git. CI keeps it honest.
- **One config file for the suite.** Repositories configure exclusions and entry points once.

## Open questions

- Whether to also publish the CLIs to npm for CI use outside Claude Code, or have CI call the bundles from a checkout of this repo.
- Where team-level aggregation of transcript metrics should live, if anywhere.
- Whether to stop committing `dist/` to the main branch. A marketplace entry's `source` can name a `ref`, so CI could build a release branch instead. That would end the conflicts that committed bundles and mandatory version bumps cause between any two open changes, and would keep the WASM grammars, shipped once per parsing plugin, out of the main history.
