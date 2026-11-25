# complexity

Finds the functions that are hard to understand, explains line by line where their complexity comes from, guides simplifications that avoid shallow helpers, and gives CI a check that exits with 1 only on a regression. It runs locally and sends nothing anywhere.

## Part of the code-health suite

complexity is one of four plugins in the [code-health suite](https://github.com/dave-hillier-co/code-health), which finds where code is expensive to change, guides an agent through fixing it, and measures whether later changes got cheaper.

| Plugin | Question |
|---|---|
| [cochange](https://github.com/dave-hillier-co/code-health/tree/main/plugins/cochange) | Where does change effort concentrate, and what changes together? |
| **complexity** | Which functions are hard to understand, and where does the complexity come from? |
| [structure](https://github.com/dave-hillier-co/code-health/tree/main/plugins/structure) | Which dependencies make change expensive? |
| [locality](https://github.com/dave-hillier-co/code-health/tree/main/plugins/locality) | Which code lives far from the code that uses it? |

Each plugin installs separately and none needs another. They share one config file, `code-health.json`, and one cache, `.cache/code-health/`, and each reads the others' stored results when they exist. A whole-repository run of `complexity files` on a clean tree stores the file report the other plugins read, and cochange's `change-risk` skill uses `complexity diff` as evidence for a branch.

## Skill

`complexity` covers finding the hardest functions, explaining one, simplifying it without splitting it into shallow helpers, measuring whether the simplification made the code cheaper to change, and setting up the CI check.

## Commands

Run the CLI as `node <plugin folder>/dist/complexity.mjs <command>`. It prints a table in a terminal and JSON with `--json` or when piped. `--help` lists every command and its options.

| Command | Prints |
|---|---|
| `analyse` | The production functions that are hardest to understand, ranked by cognitive complexity, then nesting, cyclomatic complexity and length, with the tests counted apart. |
| `explain` | A line-by-line breakdown of where one function's complexity comes from, or the description of a rule. |
| `depth` | Exported functions, classes and modules ranked by interface depth, exported pass-throughs first. |
| `diff` | Functions added or changed between two revisions, or a revision and the working tree, with before and after. |
| `check` | Exits with 1 when a new function is above a guideline, or an existing one above a guideline got worse than at a base revision. |
| `files` | File-level aggregates. |
| `fixes` | Per function: fix commits in the history window, revisions touching it, fix share and current cognitive complexity. |
| `outcome` | Whether a simplification made code cheaper to change: change cost, fix rate, rank, the function-count gaming check and agent effort, before and after, against files left alone. |
| `report` | An HTML or Markdown page: `xray` (the functions of one file) or `trends` (code lines and cyclomatic complexity of the repository and its folders over sampled revisions). |

`config explain` prints the effective config and where each value came from.

Guideline values order and annotate results and never hide them. `check` is the only command that exits with 1, and only on a regression against the base revision.

## Languages

Exact metrics cover TypeScript and JavaScript, C#, C++, Python, Go, Java, Kotlin and Rust. Indentation-based metrics work for any text file. See [languages.md](https://github.com/dave-hillier-co/code-health/blob/main/docs/languages.md).

## Install

```
/plugin marketplace add dave-hillier-co/code-health
/plugin install complexity@code-health
```

Requires Node 22.13 or later and git, with a full clone: a shallow clone has truncated history. The plugin has no other dependencies and needs no `npm install`.

## Licence

Dual-licensed under `AGPL-3.0-only` or a commercial licence. See [LICENSING.md](https://github.com/dave-hillier-co/code-health/blob/main/LICENSING.md).
