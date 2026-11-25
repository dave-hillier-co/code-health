# code-health

A suite of Claude Code plugins that find where code is expensive to change, guide an agent through fixing it, and measure whether later changes got cheaper. They work from git history and source structure, run locally, and send nothing anywhere.

## Why

Code is expensive to change when a change needs knowledge the code does not put in front of you: a second file that must change too, a function too tangled to hold in mind, a helper three folders away, a dependency on code that changes every week. An agent pays these costs more directly than a person. It works one file at a time, cannot recall what usually changes alongside, and pays for every hop in files opened and tokens read.

The suite rests on three positions:

- **History shows cost, structure shows cause.** A complex file nobody touches costs nothing. A complex file that changes every week is where the effort goes, and two files that always change together are a dependency whether or not an import says so.
- **A score is not an outcome.** Any score optimised alone gets gamed, so each plugin measures an outcome from later history or agent sessions (change spread, change cost, agent effort) and names the check that shows its own score being gamed. There is no single code health score.
- **Facts are mechanical, remedies are judgement.** A deterministic CLI computes the facts. A skill holds the policy, and the agent decides and records why.

Numeric values are guidelines: they order and annotate results and never hide or fail them. The only commands that exit with 1 are the ones you run as a gate.

[docs/basis.md](docs/basis.md) gives the full reasoning and the sources: Tornhill and CodeScene for behavioural code analysis, Ousterhout for the design vocabulary, Martin for dependencies and packages, and the research behind the knowledge-loss and change-risk analyses.

## The plugins

Each plugin is a CLI that prints facts and one or more skills that tell Claude when to run it and what to do with the answer. They install separately and none needs another, though each reads the others' stored results when they exist.

| Plugin | Question | Skills |
|---|---|---|
| `cochange` | Where does change effort concentrate, and what changes together? Hotspots, temporal coupling, change spread, fix counts and a briefing before an edit. | `cochange`; `change-risk`, how a branch should be reviewed before it merges; `abandonment`, knowledge lost when people leave (off until the repository opts in); `identities`, a reviewed `.mailmap` |
| `complexity` | Which functions are hard to understand, and where does the complexity come from? Cognitive and cyclomatic complexity, nesting, interface depth, and a check for CI that exits with 1 only on a regression. | `complexity` |
| `locality` | Which code lives far from the code that uses it? Recommends moving, inlining or splitting, and makes moves as one move-only commit each. | `locality` |
| `structure` | Which dependencies make change expensive? Import cycles with their smallest breaking sets, layer rules, dependencies from stable code onto volatile code, and the decoupling mechanisms already in use. | `structure`; `packaging`, whether the packages are the right ones |

It suits medium to large codebases in one repository: applications, modular monoliths and monorepos. It is a poor fit for a repository per microservice, where each repository is small and the coupling that matters crosses services. History-based findings need history, so every result that uses it grades its evidence as strong, moderate or weak.

## Languages

The history layer works for every file. Indentation-based metrics work for any text file. Full support (exact metrics, resolved dependencies, deterministic moves) covers TypeScript and JavaScript, C#, C++, Python, Go, Java, Kotlin and Rust. See [docs/languages.md](docs/languages.md).

## Install

```
/plugin marketplace add dave-hillier-co/code-health
/plugin install cochange@code-health
/plugin install complexity@code-health
/plugin install structure@code-health
/plugin install locality@code-health
```

Requires Node 22.13 or later (for unflagged `node:sqlite`) and git, with a full clone: a shallow clone has truncated history. The plugins have no other dependencies and need no `npm install`. The external tools that confirm a move (a language server, rope) are used when installed and never required.

### Codex

All eight skills can be packaged for Codex: `cochange`, `change-risk`, `abandonment`, `identities`, `complexity`, `locality`, `structure` and `packaging`. Each installs independently with its own runtime. Codex session effort and coupled-change completeness are unavailable: the transcript reader currently understands Claude Code sessions only. Git-based outcomes, static analyses and reports remain available; locality uses `measure change` and `report trends` as leading indicators rather than claiming an effort improvement.

From a checkout with development dependencies installed, generate the standalone skills from the current committed CLI bundles and shared instructions:

```sh
npm run package:codex
npm run check:codex
```

The output is `.cache/codex/skills/`, with one directory per skill. Copy the desired **whole skill directories** to `<target-repository>/.agents/skills/` for repository-local discovery, then invoke `$cochange`, `$locality`, or another installed skill in Codex. Keep installation changes separate from code being analysed; each skill includes its runtime, grammar files, references, schemas and licence notices and needs no `npm install` after copying. Node 22.13 or later and git must be available on the machine running Codex. Skills that share a plugin include separate runtime copies so they can be installed individually.

Packaging refuses to overwrite an existing directory. For a new build, provide a fresh output path with `npm run package:codex -- /absolute/new/path/skills`. To package just one skill, use `npm run package:codex -- --skill locality /absolute/new/path/locality` (without an output path, this uses `.cache/codex/skills/locality`). After changing CLI source, run `npm run build` before packaging; the existing `check:dist` check verifies that bundles match source. Generated skills use absolute executable paths while running in the target repository and follow Codex's sandbox permissions. Analyses write caches; worktrees share the main checkout's history cache.

The generated instructions preserve the abandonment opt-in and identity review safeguards. Refactoring follows the user's requested scope; commit guidance applies when commits are requested. Locality apply examples use `--no-commit` to leave edits staged by default. Commit-based verification is deferred until a requested commit exists.

The packaging tests relocate each skill outside the checkout and run its CLI against isolated Git repositories without installing dependencies there. They cover report generation, the complete runtime and reference links, abandonment opt-in, read-only analyses, and a locality move that leaves changes staged without a commit. This verifies packaging and execution, not model-level skill selection or judgement.

## Use

Ask Claude in the terms of the problem, and the matching skill runs the CLI:

- "What usually changes with this file?" before an edit
- "Where should we refactor first?"
- "Why is this function hard to follow?"
- "Is this `utils` folder worth keeping?"
- "How do I break this import cycle?"
- "How risky is this branch, and who should review it?"

Each CLI can also be run directly, in a terminal or in CI, as `node <plugin folder>/dist/<plugin>.mjs <command>`. It prints a table in a terminal and JSON with `--json` or when piped. `--help` lists the commands, `explain <rule>` describes a recommendation rule, and `config explain` prints the effective config and where each value came from.

`<plugin> report <kind>` renders an HTML or Markdown page for a person to read: the CLI computes and prints every number, and the agent writes only the judgement. The reports are `cochange report overview`, `hotspots`, `coupling`, `knowledge` and `change` (a pull request summary), `complexity report xray` and `complexity report trends` (code lines and cyclomatic complexity of the repository and its folders over sampled revisions, as charts), `structure report structure`, `locality report locality` and `locality report trends` (import distance of the repository and its folders over sampled revisions, as charts).

### Configuration

Settings are optional and live in one committed file at the repository root, `code-health.json`, shared by every plugin: `exclude` globs, test patterns, the history window, and each plugin's guidelines. [code-health.schema.json](code-health.schema.json) describes every key with its default and where the default comes from. An unknown key is an error.

Results are cached in `.cache/code-health/`, which ignores itself in git and can be deleted at any time. State that cannot be regenerated, such as a measurement baseline, is kept in `.code-health/local/`.

### People

Default outputs contain no author identities. The knowledge analysis is off until `cochange.knowledge.enabled` is set, models random turnover only, and never ranks or predicts individuals. See "People" in [docs/basis.md](docs/basis.md).

## Repository layout

- `plugins/` what users install: one self-contained folder per plugin, with its manifest, skills, schemas, evals and committed `dist/` bundle
- `packages/` TypeScript source: one package per plugin, and the shared packages (`cli-kit`, `history`, `lexical`, `parse`, `graph`, `report`, `transcripts`) bundled into each plugin's CLI
- `shared/` single-source files: `red-flags.md` and `reports.md`, copied into every skill at build time, and the pinned eval settings
- `fixtures/` helpers that build deterministic git repositories for tests, and the per-language conformance fixtures
- `scripts/` the build, the checks, the plugin scaffold and the eval runner
- `docs/` [basis.md](docs/basis.md), why the suite is built as it is, [languages.md](docs/languages.md), how each language is read, and [slopcodebench.md](docs/slopcodebench.md), what the SlopCodeBench paper reports about static measures and the next change's cost

## Build and test

```
npm install
npm run build
npm test
npm run check
```

`npm run build` bundles every plugin's CLI into `plugins/<plugin>/dist/`, which is committed because installing a plugin copies its folder and runs no build. `npm run check` runs the typecheck, the tests and every gate CI runs, including a run of the bundled CLIs on this repository.

Tests are sociable: they run the real CLI against real git repositories created by `fixtures/git-fixture.ts` with fixed identities and dates. Run one package with `npx vitest run packages/<name>`.

[CONTRIBUTING.md](CONTRIBUTING.md) covers adding a plugin, a command, a report, a skill or a language, the checks one by one, and running evals.

## Licence

Dual-licensed under `AGPL-3.0-only` ([LICENSE](LICENSE)) or a commercial licence. See [LICENSING.md](LICENSING.md). External contributions are not accepted yet.
