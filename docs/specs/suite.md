# Code Health Suite — Spec

This spec covers the conventions shared by every plugin in this marketplace. Each plugin spec ([locality](locality.md), [cochange](cochange.md) with its [abandonment](abandonment.md) and [identities](identities.md) skills, [complexity](complexity.md)) assumes this one, and [red-flags.md](red-flags.md) is the shared design vocabulary.

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
2. **Determinism where mechanical, judgement where semantic.** The CLI computes facts and deterministic recommendations, so the same repo, config and history produce byte-identical JSON. The agent supplies judgement and records every override with a reason.
3. **CLIs report, they do not edit.** Analysis commands never modify code. Mechanical edit commands (such as the locality mover) are separate, default to a dry run, and need `--apply`.
4. **One refactoring per commit.** Every applied change is a single, revertible step with tests green before and after. A reviewer never evaluates a move and a behaviour change together.
5. **Evidence beats convention.** Folder conventions, anticipated reuse and metric thresholds are hypotheses. History and consumer evidence decide. The rule of three marks when to *consider* removing duplication or keeping an abstraction. It is never a mechanical rule in either direction.
6. **Deep over shallow, and inline by default.** Remedies hide decisions behind simple interfaces. Inlining single-use indirection is a first-class remedy (Carmack, Blow). No plugin creates new shared helpers or abstractions, and any extraction stays local (see [red-flags.md](red-flags.md)).
7. **Scrutinise what is widely used.** High fan-in multiplies the cost of every flaw. Utilities with many consumers have earned their location, and they are the first place to check for red flags.
8. **Built for agents, usable by people.** Output is compact, ranked and limited by default. JSON is the contract, and a human-readable table is the default view in a terminal.
9. **Local and private.** No network access, no telemetry. Data about people is off by default.
10. **Self-contained plugins, composed by data.** No plugin requires another at runtime. They share code at build time and exchange results through files.
11. **Patterns emerge from the codebase.** Where a remedy involves a design mechanism (an interface, events, a mediator), skills prefer what the codebase already uses nearby and ask before introducing anything new. No skill defaults to a named pattern. CLIs provide the census of what exists; the agent chooses.
12. **Language-agnostic first.** As much as possible works from history, indentation and lexical structure, which apply to every language and every historical revision. Language adapters add precision where the agnostic layer cannot answer: import resolution, exact metric definitions, deterministic moves. A repository in a language with no adapter still gets most of the suite.

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
fixtures/                           scripts that build deterministic fixture repos
```

Rules:

- **Installed plugins are copied** to `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`. Nothing outside the plugin folder is copied, and paths that escape it are rejected. Shared code therefore reaches a plugin only by bundling: esbuild bundles each CLI with its `packages/*` dependencies into one ESM file in `dist/`.
- **`dist/` is committed**, because installation is a git copy with no build step. CI rebuilds every plugin and fails if `dist/` differs from the committed build, so the shipped bundle always matches its source.
- **No runtime npm install.** Bundles have no external dependencies. WASM assets sit next to the bundle and are resolved relative to `import.meta.url`.
- **No `index.ts` barrel files.** Modules are imported by their real path, which keeps the suite's own import graph honest for the locality analyser.
- **No top-level `bin/`.** It would put the CLI on the Bash PATH, but claude.ai and Cowork do not install plugins that contain one. Skills call `node ${CLAUDE_PLUGIN_ROOT}/dist/<plugin>.mjs` instead.
- **Plugin names** are kebab-case and avoid the reserved prefixes (`claude-`, `anthropic-`, `cc-plugin-`).

## Plugin anatomy

### plugin.json

Each plugin's manifest is `name`, `displayName`, `version`, `description`, `author`, `license`, `repository`, `keywords` and `engines.claude-code`. The version is set **in plugin.json only**, never also in the marketplace entry, where plugin.json would win silently. Users of a third-party marketplace get updates only when the version string changes, so CI fails a change under `plugins/<plugin>/` that does not bump that plugin's version.

### Skills

- One skill per user question, not per CLI command. Most plugins need one skill. A second is justified when it is triggered by a different situation, such as a pre-change briefing versus a periodic review.
- `SKILL.md` stays under 500 lines and holds the workflow, decision policy and commit discipline. Thresholds and long explanations go in `references/`, loaded on demand. Every line of SKILL.md is a recurring token cost.
- The `description` says when to use the skill in the user's terms ("before refactoring", "code that is hard to change", "what usually changes with this file") and is covered by trigger evals.
- `allowed-tools` pre-approves the plugin's own CLI so runs do not prompt each time: `Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/<plugin>.mjs *)`. It never approves anything broader.
- `${CLAUDE_PLUGIN_ROOT}` is substituted in skill content but is **not** in the environment of Bash commands, so skill text writes the CLI path out in full through substitution and never relies on the variable at runtime.

### Hooks

Hooks are opt-in per repository, because injected context costs tokens. A plugin's hook command reads the repo config and exits silently unless that config enables it. Hook rules:

- Exec form with `${CLAUDE_PLUGIN_ROOT}`, a hard time budget of a few hundred ms, and a read-only cache lookup only. A hook never refreshes caches, never blocks, and never exits 2.
- Context goes back through `hookSpecificOutput.additionalContext` as one short factual sentence, at most once per file per session.

### Configuration

All plugins read one committed file at the repo root, `code-health.json`, with a `$schema` reference. It has a top-level `exclude`, `languages` and `entryPoints` shared by every plugin, and one section per plugin. Each plugin validates its own section and ignores the others. Missing config means defaults. Every CLI has `config explain` to print the effective config and where each value came from, so the skill can explain it. Plugin `userConfig` is not used, because these settings belong to the repository, not the user.

## CLI contract

Every plugin's CLI follows the same conventions, implemented once in `packages/cli-kit`.

- **Invocation.** `node <dist>/<plugin>.mjs <command> [options]`. It needs Node ≥ 22.13 for unflagged `node:sqlite`, and the CLI suppresses its experimental warning.
- **Output.** A table on a TTY, JSON with `--json`, or `--json` piped. Every JSON document has `schemaVersion`, `tool`, `command`, `repo` (HEAD SHA and dirty flag), `config` (hash of effective config), `results` and `truncated`. No wall-clock timestamps appear outside `meta`, so outputs stay diffable.
- **Determinism.** Results are sorted by score, then by path. Paths are repo-relative POSIX. Floats are rounded to a fixed precision. Golden tests enforce byte-identical output.
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

- Location: `.cache/code-health/` at the repo root. On first use the CLI writes `.cache/code-health/.gitignore` containing `*`, so nothing needs adding to the repo's own `.gitignore`. Nothing is ever written inside the plugin folder, which is replaced on update.
- `history.sqlite`: commits, changed paths with numstat, and the rename map. It is maintained by the `history` package and bundled into every plugin that reads history, so any of them can refresh it. Refreshes are incremental from the last processed SHA, and the cache rebuilds when that SHA is no longer an ancestor of HEAD. A schema version number triggers a rebuild on mismatch, and a write lock makes concurrent refreshes safe.
- `parse/`: parse results keyed by git blob SHA and grammar version. Unchanged files are never re-parsed, and historical revisions can be analysed by blob.
- `reports/<plugin>.<command>.json`: the latest output of each command, stamped with HEAD. This is the composition seam. A plugin may read another's report when it is present and current, and must work identically without it.

## Languages

### Analysis layers

Every plugin's analysis is built in three layers. Each one works without the layers above it.

| Layer | Input | Works for | Provides |
|---|---|---|---|
| **History** | git log, numstat, blame | Every file, every language | Co-change, hotspots, spread, age, abandonment, identities, change stability, hidden coupling, change magnets |
| **Lexical** | Indentation plus a tiny per-family lexer profile: comment and string delimiters, block style (braces, indentation, `end` keywords) and a branch-keyword list | Any language with a family profile; any historical blob | Indentation complexity, bumpy road, nesting, approximate function blocks and their length, keyword complexity, append-shaped edits, lexical duplication |
| **Structural** | Tree-sitter grammar plus a language adapter | Tier 1 and tier 2 languages | Exact units and metric definitions, import and symbol resolution, dominator units, census, deterministic moves |

Lexer profiles are data, not code. A C-family profile covers C, C++, C#, Java, Kotlin, JavaScript, TypeScript, Go, Rust, Swift, Dart, PHP and Scala. An indentation profile covers Python, YAML-like and F#-like languages, and a keyword-block profile covers Ruby, Lua and Elixir. Adding a language to the lexical layer is a few lines of config.

Every output says which layer produced each value (`source: history | lexical | structural`). When the structural layer is available it wins, and the lexical value can be shown alongside for comparison. The lexical layer is also what makes history-wide analysis affordable: trends over hundreds of past revisions run on the lexical layer, without parsing any of them.

### Tiers

Tree-sitter WASM grammars run through `web-tree-sitter`, with no native builds. A plugin ships the grammars for every supported language and loads only those present in the repository.

| Tier | Languages | Support |
|---|---|---|
| **1** | TypeScript/JavaScript, C#, C++ | All three layers, with full adapters for every plugin |
| **2** | Python, Java, Kotlin, Rust | Next, in roughly that order. Java and Kotlin share one JVM graph, so mixed projects resolve across both. |
| **0** | Everything else | History and lexical layers. Most findings are available, with no deterministic moves and no import-graph units. |

Within tier 1 the build order is TypeScript, then C#, then C++, from easiest to hardest resolution. TypeScript also has a mature codemod (ts-morph) for deterministic moves.

An adapter is listed as supported only when it passes the shared conformance fixtures for every plugin that uses it.

### Dependency models

A language adapter turns source into file and symbol dependencies. Languages differ in how dependencies are written, so adapters work in one of two modes, and the graph package consumes both the same way.

- **Import-based**: a statement names a file or module (TypeScript, Python, Rust `mod`/`use`). The resolver maps specifiers to files.
- **Symbol-based**: a statement brings in a namespace, or nothing at all (C# `using`, Java and Kotlin same-package references, C++ declarations visible through headers). The adapter builds a table of declared types and members per file, then resolves referenced identifiers against it to derive file edges. The resolution is heuristic: it follows names without overload or template resolution, so it is good enough for ranking. Before any move, references are confirmed with the language's LSP server.

### Language notes

| Language | Resolution | Boundaries (fixed points) | Moves | Notes |
|---|---|---|---|---|
| TypeScript/JavaScript | tsconfig `paths`, package `exports`, barrels followed through | Workspace packages | ts-morph | Dynamic `import()` and framework file conventions need configured entry points |
| C# | Symbol-based over `using` and namespaces. Partial classes merge into one unit across files. | Projects (`.csproj` and their references), solutions | File move plus namespace update to match the folder. SDK-style projects glob sources, so no project edit is needed. Confirm with the Roslyn LSP. | Namespace and folder can disagree. Distance uses folders, because agents navigate files. |
| C++ | `#include` resolved with include paths from `compile_commands.json`. A header and its source file form one unit. Symbol-based for calls. | Build targets (CMake targets, and other build systems by config) | Move plus rewriting `#include` paths and target source lists. There is no mature codemod, so the agent performs the build-file edits and clangd confirms references. | The preprocessor is not run. Conditional compilation is parsed as written, and macro-generated code is invisible, which is reported per file. |
| Python | Package roots, `__init__.py` re-exports | Distribution packages (`pyproject.toml`) | rope | Dynamic imports need configured entry points |
| Java / Kotlin | Packages map to folders; symbol-based within a package | Gradle and Maven modules | LSP rename (jdtls, Kotlin LSP) | One graph across both languages |
| Rust | `mod` tree and `use` paths | Crates and Cargo workspaces | rust-analyzer | The module tree is explicit, so resolution is precise |

### Metric definitions per language

The complexity plugin's conformance fixtures pin down per-language constructs: C# switch expressions, pattern combinators and `??=`; C++ lambdas, `goto` and preprocessor branches (not counted); Kotlin `when` and elvis (not counted, as null-coalescing); Rust `match`, `if let` and `?` (not counted). Each language follows the cognitive complexity specification's rules for its constructs.

## Testing

The testing style is classic TDD with sociable tests. Mocks are reserved for process boundaries.

- **Fixture repositories.** Scripts in `fixtures/` build real git repositories in temp directories with fixed author and committer dates, so their histories are reproducible. Tests run the real CLI against them. There are no mocked git or parser layers.
- **Golden outputs.** JSON output per fixture is compared byte for byte. An intentional change updates the golden file in the same commit.
- **Algorithm properties.** Graph algorithms (dominators, LCA, coupling) are checked against naive reference implementations on generated graphs. For dominators, the reference is the textbook iterative data-flow method: *d* dominates *n* exactly when removing *d* disconnects *n* from the root. SCC condensation is checked by confirming that no unit splits a cycle.
- **Metric conformance.** Small source fixtures per language with hand-verified expected values for each metric.
- **Skill evals.** `claude plugin eval` cases in each plugin's `evals/` cover triggering (the skill loads on relevant prompts and not on unrelated ones) and behaviour (it runs the CLI, respects grace periods and commit discipline, and cites red flags). The model and judge model are pinned, and a cost ceiling is set. Evals run on demand and before release, not on every push, because each run is billed.
- **Validation.** `claude plugin validate --strict` runs on the marketplace and every plugin in CI.

## Release

- Each plugin is versioned with semver independently. A breaking JSON schema change is a major bump, and a change in recommendation output for the same input is at least a minor bump, called out in the changelog.
- CI gates: build reproducibility, the version-bump check, the full test suite, plugin validation and schema checks of the golden outputs.
- Team adoption: commit `extraKnownMarketplaces` and `enabledPlugins` in the project's `.claude/settings.json`, then each collaborator runs `claude plugin install <plugin>@code-health --scope project` once per clone.

## Measurement across the suite

Each plugin defines its own outcome measure, and the suite shares the instruments:

- **Change spread** (from the history cache): mean pairwise tree distance of files per logical change.
- **Agent effort** (from Claude Code session transcripts in `~/.claude/projects/`): files read, distinct folders visited, re-reads and tokens per task. Only paths and counts are extracted. Measurement is local by default, and any team aggregation exports counts and repo-relative paths only, never content.
- **Before and after windows**: baseline before the first change, then compare over a matching window afterwards, with the same filters. Reports state sample sizes, and the skill does not claim an effect the data cannot show.

## Roadmap

Candidate plugins, each to get its own spec before work starts:

- **idioms**: replacing thin wrappers and re-implementations with standard-library or platform idioms (out of scope for locality).
- **duplication**: clone detection, reporting only, built on the lexical layer (normalised token windows) so it works in every language. The remedy is judgement, and creating shared helpers needs consumer evidence first.
- **structure**: specified in [structure.md](structure.md). Dependency cycles, layer violations and stability, with evidence packs for judgement-led dependency breaking.

## Decisions

- **Plugins, CLIs and skills; no MCP servers.** The work is batch-shaped, a CLI is testable and usable in CI, and nothing costs context until a skill calls it.
- **Self-contained bundles over runtime plugin dependencies.** Each plugin installs and works alone. Composition is optional and goes through report files.
- **Committed `dist/`.** Installation copies git content, so the build must be in git. CI keeps it honest.
- **One config file for the suite.** Repositories configure exclusions and entry points once.

## Open questions

- Whether to also publish the CLIs to npm for CI use outside Claude Code, or have CI call the bundles from a checkout of this repo.
- Where team-level aggregation of transcript metrics should live, if anywhere.
