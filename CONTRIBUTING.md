# Contributing

This file says how to work in the repository: how to add a tool, a command, a report, a skill or a language, and which checks gate a change. `README.md` describes the layout, `docs/basis.md` explains why the suite is built as it is, and `docs/languages.md` says how each language is read. The code, its tests and its golden files are the source of truth for behaviour.

## Contributions

External contributions are not accepted yet. Until contribution terms are published here, pull requests, patches and other submitted code will not be merged. Issues reporting bugs are welcome. This file describes how the code is developed.

## Working rules

- TypeScript ESM, no `index.ts` barrel files. Import modules by their real path.
- Classic TDD with sociable tests: real fixture git repositories (`fixtures/git-fixture.ts`) and the real CLI, mocks only at process boundaries.
- JSON is the CLI contract. Every command's `--json` output has a golden file and a JSON Schema.
- Output is deterministic: no wall clock, no listing order, no absolute paths in results.
- Install packages with the npm CLI (`npm install <pkg> -w <workspace>`), never by editing `package.json`.
- One logical change per commit. Run `npm run check` before committing.
- The repository ships one plugin, `plugins/code-health/`, which holds every skill and the bundled CLI of every tool (`cochange`, `complexity`, `locality`, `structure`). A tool is a package with a CLI source at `packages/<t>/src/main.ts`.
- A change to a tool's source needs a rebuilt, committed `dist/` (`npm run build`). The plugin's version stays at `0.1.0` until the first public release, so no bump is needed. The version lives in `plugin.json` only, never in the marketplace entry.
- Evergreen content only in `README.md`, `CONTRIBUTING.md` and `docs/`: no status updates.
- Numeric values are guidelines that order and annotate results. A new one is a named config key whose schema description says it is a guideline and where its default comes from, and it never hides a result or sets exit code 1 (see "Guidelines" in `docs/basis.md`).

## Adding a tool

```
npm run new-tool -- <name> [--parses]
npm install
npm run build
npm test
```

`<name>` is kebab-case. Pass `--parses` when the tool needs syntax trees. `npm install` links the new workspace and updates the lock file, so commit `package-lock.json` with the tool. A new tool adds no plugin: its bundle, schemas, skills and evals go in `plugins/code-health/`.

The scaffold (`scripts/new-tool.mjs`, templates in `scripts/templates/tool/`) creates:

| Path | Purpose |
|---|---|
| `plugins/code-health/schemas/<t>/common.schema.json` | The envelope shared by every command schema, with `tool` fixed to `<t>`. |
| `plugins/code-health/schemas/<t>/<command>.schema.json` | Schema of the placeholder command. |
| `packages/<t>/package.json`, `tsconfig.json` | A private workspace named `@code-health/<t>`. |
| `packages/<t>/src/main.ts` | The CLI entry. `scripts/bundle.mjs` bundles every package whose `packages/<t>/src/main.ts` exists, to `plugins/code-health/dist/<t>.mjs`. |
| `packages/<t>/src/{cli,tool,config,commands}.ts` | CLI definition, tool name and schema version, config section, command list. |
| `packages/<t>/src/commands/<command>.ts` | One placeholder command (`describe`, or `parse` with `--parses`). Replace it with the tool's first real command. |
| `packages/<t>/test/` | A runner (`support/run.ts`) and a test of the placeholder command. |

### Commands

A command is a module in `packages/<t>/src/commands/` exporting `name`, `command` and optionally `rules`. Add it to `commandModules` in `commands.ts`, one import and one list entry in alphabetical order. Commands that read history use `analysisCommand` as `packages/cochange/src/analysis-command.ts` does. Reuse the shared packages (`cli-kit`, `history`, `lexical`, `parse`, `graph`) before writing a capability: if a package already does it, import it.

Every command gets:

1. a schema `plugins/code-health/schemas/<t>/<command>.schema.json` composing `common.schema.json`,
2. golden outputs at `packages/<t>/test/golden/<scenario>/<command>[.<variant>].json`, written through `expectGoldenIn` from `@code-health/fixtures/cli-testing` (wrap it as `packages/cochange/test/support/golden.ts` does) and refreshed with `UPDATE_GOLDEN=1`, with the diff reviewed,
3. a test that runs the CLI in-process with `runInProcess` from the same module.

`npm run check:schemas` compiles every schema and validates every golden against the schema named by its file name. Scenario folders starting with an underscore are exempt.

A command may group subcommands that share its setup, as `structure packages <list|cohesion|coupling|boundaries|candidates|evidence|check|outcome>` does. The command module dispatches on its first positional argument to subcommands in `packages/<t>/src/<area>/commands/`, which each export a `Subcommand` (`summary`, optional `options`, `analyse`). They share one schema, `plugins/code-health/schemas/<t>/<command>.schema.json`, whose branches are selected by `inputs.subcommand`. Goldens name the subcommand as the variant, such as `packages.list.json`.

### Modules loaded on demand

A module a command loads with `await import("./x.ts")` is built into `plugins/code-health/dist/chunk-<hash>.mjs`, with whatever only it uses, and is read only when the command runs. Use it for a heavy dependency that most commands never need, as locality does for ts-morph. A module that holds shared state must stay in the main bundle: a chunk is another file, so it would not be the same module. `npm run build` writes the chunks and removes ones that are no longer produced, and `npm run check:dist` compares them.

### Tools that parse

A tool parses when its bundle includes `packages/parse/src/grammars.ts`, directly or through another package. When any tool parses, the build copies the tree-sitter `.wasm` files into `plugins/code-health/dist/grammars/`, once for all the tools, with `copyGrammars` from `packages/parse/src/copy-grammars.ts`. Nothing else is needed in the tool:

- Load grammars with `loadGrammar` from `@code-health/parse/grammars`. It resolves `grammars/` relative to `import.meta.url`, so the installed bundle finds them beside itself, and falls back to the npm packages when running from source.
- The `dist/grammars/` files are committed, and `npm run check:dist` fails when they differ from a fresh build or exist when no tool parses.
- `scripts/test/new-tool.test.ts` shows the check to copy for a new parsing tool: build, copy `dist/` to a directory with no `node_modules`, run the bundled CLI there to parse a file.

### Bundles

Bundles import only Node builtins and install without `npm install`. Do not add runtime dependencies that cannot be bundled, and do not read files by repository-relative path at run time: anything a bundle needs ships in `dist/` and is found through `import.meta.url`.

## Maintainer commands

Four commands calibrate or evaluate the suite on a corpus of repositories. They are for the suite's maintainers and not for end users. They stay runnable, but are marked `hidden` in their command definition (`hidden: true` on a `Command` or a `SubcommandHelp`, `hiddenOptions` for options only they take), so they are left out of `--help` listings, and no skill or reference mentions them. `<command> --help` or `<command> <subcommand> --help` still describes one.

| Command | What it checks | Notes |
|---|---|---|
| `cochange risk backtest [--since DATE] [--adopted DATE]` | Whether the change-risk levels separate past changes that were later reverted or fixed | A run on a clean tree with no `--since` or `--adopted` stores its result under `.cache/code-health/reports/`. `cochange risk` shows a level only where that stored result says the levels separate |
| `cochange abandonment backtest [--at DATE] [--horizon P] [--trials N] [--seed S] [--top N]` | At a past date, the predicted at-risk files against the files abandoned one horizon later | Needs `cochange.knowledge.enabled` set to `true` in the corpus repository's `code-health.json`, and prints precision and recall without storing them |
| `complexity backtest [--samples N] [--months M] [--unit file\|function]` | Whether a file's (or a function's) size and complexity at past revisions order the files (or functions) by the changes, lines churned and fixes of the period that followed | Prints Spearman rank correlations for each measure (for a file: code lines, cyclomatic and cognitive complexity, the share of weighted complexity above the guideline, indentation complexity, prior changes and their product; for a function: code lines, cyclomatic and cognitive complexity, nesting, parameters and prior changes) and each again with code lines held fixed, within each period and pooled over the periods. `--unit function` follows each production function from one revision to the next as `complexity fixes` does, and prints how many functions ended in each period. `--months` sets the span the samples cover, so more months give longer periods with more changes in each. Stores nothing |
| `locality measure premise [--since DATE] [--until DATE] [--source main\|subagent\|all] [--effort tools\|all]` | Whether tasks that edit files further apart cost an agent more reads and tokens | Reads Claude Code session transcripts, from `--projects-dir` or `~/.claude/projects` |

To run them on a corpus:

1. Build first with `npm run build`, so `plugins/code-health/dist` is current.
2. For each repository, use a full clone (a shallow clone has truncated history), on a clean working tree, and put `code-health.json` there when a command needs a setting such as `cochange.knowledge.enabled` or `history.windowMonths`. Do not commit the file to the repository under test. For `complexity backtest`, list in `exclude` the folders of fixtures, samples, examples and test inputs that the test patterns do not catch (`playground/**`, `sample/**`; the command's `possibleNonProductionFolders` names the candidates): such files are small, simple and rarely changed, and counted as production code they make complexity appear to predict change.
3. Run `node plugins/code-health/dist/<tool>.mjs <command> <subcommand> [options] --json` from inside the clone, for example `node /path/to/code-health/plugins/code-health/dist/cochange.mjs risk backtest --json`. Pipe the JSON to a file outside the clone. The first run of a large repository is slow, because it refreshes the history cache, and blame for abandonment.
4. Read `evidence.grade` first. Read `risk backtest` by `separation`, `abandonment backtest` by `precision` and `recall` (null means a zero denominator, which is not a score), `locality measure premise` by `verdict` with `tasks.measured`, and `complexity backtest` by `partialOnCodeLines` with `fileSamples` (`functionSamples` with `--unit function`), or `pooledPartialOnCodeLines` with `pooledSamples` where too few periods have enough samples, as for fix share: a measure that only repeats what code lines says has a partial correlation near 0. State the sample size next to each figure.

The outcome commands (`cochange outcome`, `complexity outcome`, `structure packages outcome`, `locality measure baseline` and `compare`) measure what a user acted on and stay user-facing. `locality measure change` is user-facing too: it measures one change, not an outcome.

## Shared blame cache

`packages/history` keeps line authorship in `.cache/code-health/blame.sqlite`, for the abandonment and change-risk skills. It is separate from `history.sqlite` (own schema version `BLAME_SCHEMA_VERSION`, own lock `blame.lock`, same rebuild-on-mismatch and `withLock` conventions), and it stores only the commit behind each line range. Identities are never stored, so a mailmap or decision change needs no re-blame. Import the modules by path, for example `@code-health/history/blame-refresh`.

**Refresh** (`blame-refresh.ts`) writes, under the blame lock:

```ts
refreshBlame(repoPath, options?: BlameRefreshOptions): Promise<BlameRefreshResult>
```

- Options: `ref` (default HEAD), `exclude` (globs), `paths` (blame only these files, and prune nothing), `copyDetection` (`-C`, default true), `ignoreRevsFile` (default `.git-blame-ignore-revs`, read from the tree at the ref), `concurrency`, `batchSize`, `onProgress({ done, total })`, `signal` (abort; what finished stays stored and the next call resumes), `lock`.
- Blames use `git blame --incremental -w -M [-C] [--ignore-revs-file]`. Vendored and generated files (gitattributes), lockfiles, excluded paths, symlinks, submodules, and binary or empty files are not blamed; the last are remembered, so they are not examined again until their blob changes.
- Result: `headSha`, `optionsId`, `files`, `blamed`, `reused`, `noText`, `failed`, `pruned`, `rebuilt`, `aborted`.
- While another process holds the lock, a refresh first reads the store (WAL mode, so the read never blocks the writer) and returns without waiting when every wanted file already has a right blame and, for a whole-tree refresh, nothing is left to prune.

**Locks** (`lock.ts`). `withLock(path, fn, options)` holds `history.lock` or `blame.lock` while `fn` runs. The lock file records the holder's process id, host, start time and command line, and the progress the holder reports through `holder.progress(text)` ("blamed 120 of 4400 files", "read 2000 of 14000 commits"). A waiter prints to stderr, never stdout, which lock it waits for, the holder and how long it has held the lock, after 2 seconds and then every 30 seconds. A lock whose holder is no longer running on this host, or, from another host, has not been touched for `staleMs`, is taken over with a stderr line saying so. `timeoutMs` (default 5 minutes) counts from the holder's last change of progress, so a holder that keeps making progress is waited for however long it takes; the timeout error names the holder and `--no-refresh`. Readers (`readBlame`, `readHistory`, and every `--no-refresh` path) take no lock. Long work prints progress through `progressReporter` in `@code-health/cli-kit/progress`: redrawn in place on a terminal, and otherwise silent for 30 seconds, then a line a minute.

**Read** (`blame-read.ts`) never blames and never writes:

```ts
readBlame(repoPath, options?: BlameReadOptions): Promise<BlameSnapshot>
// BlameSnapshot { headSha, optionsId, files: Map<path, FileBlame>, missing: string[] }
// FileBlame { path, blob, lines, ranges: { start, count, sha }[] }   (1-based lines, ordered, covering the file)
```

Use the same `exclude`, `copyDetection` and `ignoreRevsFile` as the refresh. `files` holds files with lines. `missing` lists authored files with no right blame in the cache (never refreshed, or changed since); their authorship is unknown, not zero, and consumers report it as unavailable. Without a cache every file is missing.

**Owners** (`blame-owners.ts`) apply identities at query time:

```ts
resolveOwners(root, shas, { localMailmap?, matcher? }): Promise<Map<sha, Owner>>   // Owner { key, name, email, kind }
lineShares(ranges, owners): LineShares        // { total, people, nonPerson, unattributed, byOwner }
shareHeldBy(shares, ownerKeys): number | null // the people's share held by the given owners, null when no person holds a line
commitsInSnapshot(snapshot): Set<sha>
```

`resolveOwners` reads each commit's author (merges included), maps it through the working tree `.mailmap` and the local mailmap, then classifies it with the matcher built from the identity decisions and config (`kind` is `person`, `bot`, `service` or `agent`). Lines of non-people belong to nobody and are counted apart.

**Why a blob is not the whole key.** A blame is fixed by the blob and the history behind it, and one blob can have several blames: a file reverted to earlier content is blamed on the revert. The cache is keyed by path, blob and options (`optionsId`: a hash of the flags and of the full ignore-revs SHAs), and records the commit each blame was made at. A stored blame is reused only when nothing between that commit and the ref changed the path (one `git log` per distinct stored commit, `blame-reuse.ts`). Blames made on a branch that is neither an ancestor nor a descendant of the ref are not reused, and a full refresh prunes blames whose blob is no longer in the tree. `blameLineCounts` in `blame-lines.ts` is the uncached, `-C`-less measure the identity commands use.

## Skills

A skill lives at `plugins/code-health/skills/<skill>/`, beside the skills of every other tool, so its name is unique in the plugin. `npm run check:skills` enforces these conventions:

- `SKILL.md` has YAML frontmatter and at most 500 lines. Workflow, decision policy and commit discipline go in `SKILL.md`; guidelines and long explanations go in `references/`.
- `name` equals the folder name.
- `description` is required, at most 1024 characters, and says when to use the skill in the user's terms ("before refactoring", "code that is hard to change"), not what the CLI does. Trigger evals cover it.
- `allowed-tools` is exactly one entry, the CLI of the tool the skill runs: `Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/<t>.mjs *)`. Never anything broader.
- `${CLAUDE_PLUGIN_ROOT}` is substituted in skill text but is not set in the environment of the commands the skill runs, so write the CLI path out in full in the skill text.
- `references/` holds Markdown only. Link from `SKILL.md` with relative paths (`references/<file>.md`); the check fails on a link that does not resolve.
- `references/red-flags.md` is generated. See below.

```
---
name: <skill>
description: <When the user ...>
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/<t>.mjs *)
---
```

### Shared red flags

`shared/red-flags.md` is the single source of the design vocabulary. `npm run build` copies it byte for byte to `plugins/code-health/skills/*/references/red-flags.md`, and `npm run check:red-flags` (part of `npm run check` and CI) fails when a copy differs or is missing. Edit only the shared file, then build and commit the copies together. `shared/reports.md`, how an agent writes a report's judgement, is copied and checked the same way.

### Adding a report

A tool adds a report as one entry in the `reportCommand({ ... })` registration of its `commands/report.ts` (see `packages/cochange/src/commands/report.ts`). The entry is a `ReportKind` from `@code-health/cli-kit/report-command`: its `build` returns the title, the stamp inputs, the header facts, sections of blocks (components from `@code-health/report`), the fixed limits and the slots. Three helpers keep the page short and honest, all from `@code-health/report`:

- **Empty content.** A `ranked-table` with no rows and a `stability-chart` with fewer than 3 points print one notice line, and a section whose blocks are all empty or notices prints as one line. Set `emptyText` on the block to say why it is empty ("No hubs: no file reached 2 of the 4 signals."); without it the line is "<caption>: no rows.".
- **Slots for empty content.** Return `dropEmptySlots({ title, inputs, header, sections, limits, slots })` from `empty-block.ts` instead of the plain build. It removes each `judgement` block, and its slot, that follows only empty blocks in its section (back to the previous judgement block or the section start; notices do not count), so the agent is never asked to judge nothing. A judgement with no block before it, such as a section's summary, is kept.
- **Capping a long table.** `capRows(table, max, command)` from `table-cap.ts` keeps the first `max` rows and sets `total` and `fullIn`, so the table prints "N of M shown; the rest are in `<command>` output." Name the command that lists every row, as the user would type it. A cap that leaves rows out must always say so.

Shared header text lives in `packages/history/src/report-header.ts`: `excludedCounts(filters, droppedCounts(), builtinOmissions(), { leftOutOf?, oversizedNote? })` for the header's excluded list, `historyWindowText(evidence, window, suffix?)` for its history window and `isoDate`. Do not copy them into a report.

The kit stores each kind's build in `.cache/code-health/report-builds/`, so a render reads what `--slots` computed and does not compute the report again. A stored build is reused only when the kind, its arguments and options, the working directory, HEAD, the config hash, the running code and the stored results it read are all unchanged, and a tree with uncommitted work neither reads nor stores one. A build that depends on something the kit does not check, such as a branch name or a file named by an option, returns it from `ReportKind.dependsOn` (see the change report); the result must be plain JSON and cheap to compute.

Test it with a real git fixture end to end: `--slots`, then notes, then HTML and Markdown, plus the refusal cases, as `packages/cochange/test/report-overview.test.ts` does.

## Adding a language

A language is a contained change: new files in a fixed set of places, and one registration line in each of six registries. A track adds nothing to a shared module, so tracks for different languages do not touch the same lines. Replace `<id>` with the adapter's id, kebab-case and unique (`csharp`, `cpp`, `python`, `go`, `java`, `kotlin`, `rust`). It is also the folder name under `fixtures/languages/`.

The contract is `LanguageAdapter` in `packages/parse/src/language-adapter.ts`. It covers both dependency models of `docs/languages.md`: `import-based` (a resolver maps a specifier to a file, and the shared import model follows re-exports and barrels) and `symbol-based` (the adapter extracts `FileFacts.symbols`, and the shared symbol model resolves names through namespaces and usings; a language may replace it with its own `resolve`). Both produce the same file edges, consumers, exports and units, so the graph consumers read them alike.

| Add | What it holds |
|---|---|
| `packages/parse/src/languages/<id>/adapter.ts` | The adapter: grammars and extensions, `extract`, `isTestPath`, `dependencies`, `boundaries`, `census`, `packaging`, `abstractTypes` and `mover`. Split the extractor, resolver, metric rules and census into sibling files in the same folder. |
| `packages/parse/src/languages/<id>/metric-rules.ts` | The `MetricRules` that map the grammar's node types onto the metric engine (`ConstructMap`), plus the hooks for statements, recursion and parameters. The engine in `unit-metrics.ts` is shared, so it is not edited. |
| `packages/structure/src/census/languages/<id>.ts` | The census detectors: the event, injection, handler and callback conventions of the language's ecosystem. |
| `packages/structure/src/packaging/languages/<id>.ts` | How packages of the language's ecosystems expose entry points (`readEntries`) and how their manifests compare with their imports (`manifestChecks`). Reading manifests into packages stays in `packaging/discovery.ts`, which already covers every ecosystem. |
| `packages/locality/src/movers/<id>.ts` and `<id>-backend.ts` | The mover language: a loader, so a heavy backend is loaded only when a move is planned, and the backend that moves files, rewrites references and builds the verification skeleton. An optional external tool that confirms references is declared on the adapter (`mover.confirmation`) and used when installed. |
| `packages/complexity/src/languages/<id>.ts` | The notes `complexity explain <rule>` adds where the language's constructs differ from the shared definitions. |
| `fixtures/languages/<id>/` | One folder per area (below). |

Register it by adding one line to each of these, named for the id (a dash is written as an underscore):

| Registry | Line |
|---|---|
| `packages/parse/src/registered-adapters.ts` | `export { adapter as <id> } from "./languages/<id>/adapter.ts";` |
| `packages/structure/src/census/registered-languages.ts` | `export { language as <id> } from "./languages/<id>.ts";` |
| `packages/structure/src/packaging/registered-languages.ts` | `export { language as <id> } from "./languages/<id>.ts";` |
| `packages/locality/src/movers/registered-languages.ts` | `export { language as <id> } from "./<id>.ts";` |
| `packages/complexity/src/registered-languages.ts` | `export { language as <id> } from "./languages/<id>.ts";` |
| `packages/lexical/src/recorded-agreement.ts` | Written for you by `UPDATE_AGREEMENT=1`, with `agreement-rates/<profile>.ts`. |

A registry depends only on the language files, and the module that looks languages up depends only on the registry. The types a language file needs (`PackagingLanguage`, `MoverBackend`, `ComplexityLanguage`, `CensusLanguage`, and the resolved dependency types in `packages/parse/src/resolved-dependencies.ts`) live in modules that neither the registry nor the lookup imports back through, so a language file never imports the lookup module. `packages/structure/test/own-source.test.ts` fails on an import cycle in `packages/`.

The lexer profile the adapter names (`lexerProfile`) already exists in `packages/lexical/src/profile.ts`. A grammar's npm package is installed with the npm CLI (`npm install <package> -w @code-health/parse`).

### Conformance

An adapter starts `support: "experimental"`. It is registered and tested, analyses no repository and ships no grammar. It becomes `supported` only when every suite below passes for it, so the change that flips the field is the one that proves the language. Every suite runs over every registered adapter, through each tool's real code.

| Area under `fixtures/languages/<id>/` | Run by | Pins, counted by hand |
|---|---|---|
| `adapter/<case>/` | parse | Units with qualified names, import and file edges, consumers with kinds, unresolved references, barrels, syntax errors. |
| `metrics/<case>/`, `metrics-wide/<case>/` | parse, complexity | Cyclomatic (both switch modes), cognitive, nesting, length, statements and parameters of every function. `metrics` is also in the agreement corpus, `metrics-wide` is not. |
| `depth/` | parse, complexity | Implementation nodes, interface size and forwarded call of every unit. |
| `agreement/` and `agreement.json` | lexical | Files with the awkward shapes, and the units the lexer is known to miss. |
| `census/<case>/` | structure | The decoupling mechanisms found. |
| `packaging/<case>/` | structure | Packages, entry points, abstractness and boundary findings, through `structure packages`. |
| `moves/<case>/` | locality | The reference rewrites and file texts of a move, with a `before/` tree. |

`fixtureAreas` in `fixtures/language-conformance.ts` is the list, with what each case pins and which are required. A case folder holds the sources and an `expected.json` whose values were read off the sources, never copied from the output. `describeWithTool` from the same module skips a suite with a notice when an external tool (Roslyn LSP, clangd, rope, gopls, jdtls, Kotlin LSP, rust-analyzer) is not installed: core resolution and metrics never need them, and a move without one reports `not confirmed`.

Record the lexical agreement with `UPDATE_AGREEMENT=1 npx vitest run packages/parse/test/lexical-agreement.test.ts`, review the rates, and commit them. A supported language's exact-boundary rate must clear the configured bar (0.9). To run one language while building it, `overrideSupportedAdapters` in `packages/parse/src/languages.ts` makes the real code analyse as if it were supported, which the suites do themselves.

### Grammars

The plugin ships the grammar of every supported adapter in `dist/grammars/`, from the adapters' `grammars`, and a tool loads only the ones the analysed repository has files for. Nothing is listed by hand: a new supported language changes the committed `dist/grammars`, so `npm run build` follows.

## Evals

Skill evals run with `claude plugin eval`, which bills tokens, so they run on demand and before a release and never in CI. Cases live at `plugins/code-health/evals/<t>/<case>/case.yaml`, one folder per case under the tool whose skills it exercises, and ship with the plugin. A run loads the whole plugin, so every skill is present, as it is when installed: a case that expects one skill not to load names that skill in its grader. `npm run check:evals` requires a folder of cases for every tool a skill runs.

- Format: `schema_version: "1.0"`, `name` (equal to the folder name), `execution.prompt`, `execution.model`, optional `runs`, `max_turns`, `timeout_seconds`, `tags`, and at least one grader (`regex`, `tool_used`, `tool_order`, `file_exists`, `llm`, `baseline`) with unique names. `scripts/eval-case.schema.json` is the schema `claude plugin eval` loads against. `plugins/code-health/evals/cochange/trigger-hotspots/case.yaml` is a minimal example, and `briefing-before-change` one with a scaffolded repository.
- Use `case.yaml`, not the `prompt.md` form, because only `case.yaml` can pin the model.
- A case that needs a repository sets `context.scaffold_script`, which runs only when `--scaffold` is passed. List the tools a case needs in `execution.allowed_tools`, and grant them with `--allow-tools`: `npm run evals -- <tool> -- --scaffold --allow-tools Bash,Read,Edit,Write,Grep,Glob`.
- `shared/evals.json` pins `model`, `judgeModel` and `maxCostUsd`. Every case sets `execution.model` to the pinned model, and `npm run check:evals` (part of `npm run check` and CI) validates every case without running it.
- Cover triggering (the skill loads on relevant prompts and not on unrelated ones) and behaviour (it runs the CLI, respects commit discipline, cites red flags).
- A behaviour case that needs a repository sets `context.scaffold_script` to a script in its own folder that builds one in the working directory. Claude Code runs it only with `--scaffold`. Give the script a fixed history (explicit dates), and test it: `scripts/test/cochange-evals.test.ts` runs the scripts and checks the CLI's answers against what the graders look for.
- A grader on `Bash`, `Edit` or `Write` cannot pass unless the case lists the tool in `execution.allowed_tools` and the operator grants it with `--allow-tools`. List `Edit` and `Write` in a case that asserts the agent made no edits, or the assertion proves nothing.

Run them with:

```
npm run evals -- <tool>               # billed, that tool's cases; model, judge model and cost ceiling from shared/evals.json
npm run evals -- <tool> --validate    # cost ceiling 0: Claude Code loads and validates every case, nothing is billed
npm run evals -- <tool> -- --case <glob> --runs 1   # options after the second -- go to claude plugin eval
npm run evals -- <tool> -- --scaffold --allow-tools Bash Edit Write   # behaviour cases: build their repositories and grant their tools
```

A case that needs a repository sets `context.scaffold_script` (a script that builds it in the working directory), and a case that edits files or runs commands lists those tools in `execution.allowed_tools`. Claude Code runs neither unless the operator opts in: `npm run evals -- <tool> -- --scaffold --allow-tools Bash Write Edit`.

Results and the HTML report are written to `.cache/evals/<tool>/`, outside the plugin folder. The runner refuses to run when `CI` is set.

## Checks

`npm run check` runs typecheck, tests, and these gates, which CI also runs:

| Command | Fails when |
|---|---|
| `npm run check:dist` | a committed bundle or `dist/grammars` differs from a fresh build |
| `npm run check:red-flags` | a skill's `references/red-flags.md` differs from `shared/red-flags.md` |
| `npm run check:skills` | a skill breaks the conventions above |
| `npm run check:evals` | an eval case is invalid or does not use the pinned model |
| `npm run check:schemas` | a schema does not compile or a golden does not match it |
| `npm run check:config-schema` | `code-health.schema.json` differs from what the tools' config sections generate: run `npm run config-schema` after changing a section's defaults |
| `npm run check:self` | a bundled CLI exits non-zero on this repository, reports syntax errors in a source file, or finds an import cycle outside the paths `code-health.json` excludes |
| `npm run check:plugins` | `claude plugin validate --strict` reports a problem (skipped locally without the `claude` CLI, required in CI) |
