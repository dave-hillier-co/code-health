# code-health

A Claude Code plugin that finds where code is expensive to change, guides an agent through fixing it, and measures whether later changes got cheaper. It works from git history and source structure, runs locally, and sends nothing anywhere.

The plugin is a suite of four tools. Each tool is a CLI that prints facts, with one or more skills that tell Claude when to run it and what to do with the answer.

| Tool | Question | Skills |
|---|---|---|
| [cochange](#cochange) | Where does change effort concentrate, and what changes together? | `cochange`, `change-risk`, `abandonment`, `identities` |
| [complexity](#complexity) | Which functions are hard to understand, and where does the complexity come from? | `complexity` |
| [structure](#structure) | Which dependencies make change expensive? | `structure`, `packaging` |
| [locality](#locality) | Which code lives far from the code that uses it? | `locality` |

No tool needs another to run. They share one config file, `code-health.json`, and one cache, `.cache/code-health/`, and each reads the others' stored results when they exist. The `change-risk` skill passes `complexity diff` and `structure check` output to `cochange risk` as evidence, `cochange report overview` shows the top results of each tool, and the `structure` skill hands a misplaced symbol to the `locality` skill.

The [repository README](https://github.com/dave-hillier-co/code-health) explains why the suite measures what it measures.

## Install

```
/plugin marketplace add dave-hillier-co/code-health
/plugin install code-health@code-health
```

Requires Node 22.13 or later and git, with a full clone: a shallow clone has truncated history. The plugin has no other dependencies and needs no `npm install`.

## Use

Ask Claude in the terms of the problem, and the matching skill runs its CLI:

- "What usually changes with this file?" before an edit
- "Where should we refactor first?"
- "Why is this function hard to follow?"
- "Is this `utils` folder worth keeping?"
- "How do I break this import cycle?"
- "How risky is this branch, and who should review it?"

Each CLI can also be run directly, in a terminal or in CI, as `node <plugin folder>/dist/<tool>.mjs <command>`. It prints a table in a terminal and JSON with `--json` or when piped. `--help` lists every command and its options, `explain <rule>` describes a recommendation rule, and `config explain` prints the effective config and where each value came from.

Numeric values are guidelines: they order and annotate results and never hide or fail them. The only commands that exit with 1 are the ones you run as a gate, `complexity check` and `structure check`.

## cochange

Mines git history to show where change effort concentrates and which files change together, and briefs an agent on what usually changes with a file before it edits. It reads history only, so it works for every file in every language.

| Skill | Use |
|---|---|
| `cochange` | Hotspots, temporal coupling, change spread, fix counts, and a briefing before an edit. |
| `change-risk` | How much a branch or pull request puts at risk, how to review it and who should review it. |
| `abandonment` | Knowledge lost when people leave, and who could pick it up. |
| `identities` | A reviewed `.mailmap` that maps the names and emails people commit under to one identity each. |

| Command | Prints |
|---|---|
| `brief` | A pre-change briefing for the given files: what usually changes with them, recent activity, hotspot status. |
| `hotspots` | Files or components ranked by change frequency weighted by complexity. |
| `coupling`, `clusters` | Pairs of files that change together, and groups of mutually coupled files. |
| `spread` | The change-spread distribution per week or month. |
| `fixes` | Files or components ranked by how many of their changes were fixes. |
| `risk` | How much a branch puts at risk before it is merged, and how to review it. |
| `abandonment`, `successors` | Knowledge lost when people leave, and ranked successors for files at risk. |
| `identities` | The identity mapping: list, propose, classify, apply and check. |
| `outcome` | Whether acting on findings worked: change spread against untouched files, and how often agents finish a coupled change. |
| `age`, `trend`, `components` | First-seen and last-changed dates, one file's complexity and size across its history, and the component map. |
| `report` | An HTML or Markdown page: `overview`, `hotspots`, `coupling`, `knowledge`, or `change` (a pull request summary). |

`refresh` and `blame` update the shared caches.

## complexity

Finds the functions that are hard to understand, explains line by line where their complexity comes from, guides simplifications that avoid shallow helpers, and gives CI a check that exits with 1 only on a regression.

The `complexity` skill covers finding the hardest functions, explaining one, simplifying it without splitting it into shallow helpers, measuring whether the simplification made the code cheaper to change, and setting up the CI check.

| Command | Prints |
|---|---|
| `analyse` | The production functions that are hardest to understand, ranked by cognitive complexity, then nesting, cyclomatic complexity and length, with the tests counted apart. |
| `explain` | A line-by-line breakdown of where one function's complexity comes from, or the description of a rule. |
| `depth` | Exported functions, classes and modules ranked by interface depth, exported pass-throughs first. |
| `diff` | Functions added or changed between two revisions, or a revision and the working tree, with before and after. |
| `check` | Exits with 1 when a new function is above a guideline, or an existing one above a guideline got worse than at a base revision. |
| `files` | File-level aggregates. A whole-repository run on a clean tree stores the file report the other tools read. |
| `fixes` | Per function: fix commits in the history window, revisions touching it, fix share and current cognitive complexity. |
| `outcome` | Whether a simplification made code cheaper to change: change cost, fix rate, rank, the function-count gaming check and agent effort, before and after, against files left alone. |
| `report` | An HTML or Markdown page: `xray` (the functions of one file) or `trends` (code lines and cyclomatic complexity of the repository and its folders over sampled revisions). |

## structure

Finds the dependencies that make change expensive: import cycles with their smallest breaking sets, imports that break layer rules, and dependencies pointing from stable code onto volatile code, with an evidence pack for each.

| Skill | Use |
|---|---|
| `structure` | Import cycles, layer violations, dependencies against stability, and how to break a dependency without adding machinery that hides it. |
| `packaging` | Whether a codebase has too many packages, whether a boundary is in the right place, and whether to merge or split packages. |

| Command | Prints |
|---|---|
| `cycles` | Import cycles with their smallest breaking sets, ranked by size and co-change. |
| `layers` | Imports that break the configured layer rules. |
| `stability` | Structural and change stability of folders or components, and dependencies pointing against stability. |
| `coupling`, `hidden` | Module pairs placed in the coupling quadrants (real, incidental, stable, hidden, independent), and the pairs with high co-change and low static coupling. |
| `evidence` | The evidence pack for one dependency or one finding: symbols across it, stability, co-change, misplacement. |
| `census` | The decoupling mechanisms the codebase already uses, with counts, folders and examples. |
| `hubs` | Registration hubs: files every feature edits by appending an entry. |
| `packages` | Package inventory, cohesion, coupling, boundaries and repackaging candidates. |
| `check` | Exits with 1 on import cycles or layer violations that are new since a base revision, for CI. |
| `outcome` | Whether a break reduced coupling or only hid it: co-change before and after over matching windows. |
| `report structure` | An HTML or Markdown page of the cycles, layer violations, stability, census and hubs. |

## locality

Finds code that lives far from the code that uses it, recommends moving, inlining or splitting it, and makes each move as one move-only commit with its import rewrites.

The `locality` skill covers finding distant code, judging whether a folder such as `utils` is worth keeping, choosing between a move, an inline and a split, making the move, and measuring whether a tidy-up reduced import distance.

| Command | Prints or does |
|---|---|
| `analyse` | Ranks the code that lives far from its consumers, with a default remedy for each unit. A whole-repository run on a clean tree stores its results for the other tools. |
| `scrutinise` | Reviews the widely used units: the red flags their interfaces and call sites show, with the counts behind each. |
| `move` | Plans, or with `--apply` makes, the move of one unit: file moves and import rewrites, as one move-only commit. |
| `verify-move` | Checks that a commit made by hand reproduces the planned move of one unit, and changes nothing else. |
| `update-namespaces` | After a C# move commit, plans or with `--apply` makes the optional second commit that makes namespaces follow the folders. |
| `measure` | Records a baseline before a tidy-up, compares against it afterwards, or prints how a branch changes the total import distance. |
| `history` | Updates the shared history cache. |
| `report` | An HTML or Markdown page: `locality` (the top candidates with a dry-run move plan) or `trends` (import distance of the repository and its folders over sampled revisions). |

The external tools that confirm a move (a language server, rope) are used when installed and never required.

## Languages

cochange works for every file. Indentation-based metrics work for any text file. Exact metrics, resolved dependencies and deterministic moves cover TypeScript and JavaScript, C#, C++, Python, Go, Java, Kotlin and Rust. See [languages.md](https://github.com/dave-hillier-co/code-health/blob/main/docs/languages.md).

## Configuration

Settings are optional and live in one committed file at the repository root, `code-health.json`, with keys every tool shares and one section per tool. [code-health.schema.json](https://github.com/dave-hillier-co/code-health/blob/main/code-health.schema.json) describes every key with its default. An unknown key is an error.

Results are cached in `.cache/code-health/`, which ignores itself in git and can be deleted at any time. State that cannot be regenerated, such as a measurement baseline, is kept in `.code-health/local/`.

## Licence

Dual-licensed under `AGPL-3.0-only` or a commercial licence. See [LICENSING.md](https://github.com/dave-hillier-co/code-health/blob/main/LICENSING.md). Third-party packages in `dist/` are listed in `dist/THIRD_PARTY_NOTICES.md`.
