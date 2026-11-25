# locality

Finds code that lives far from the code that uses it, recommends moving, inlining or splitting it, and makes each move as one move-only commit with its import rewrites. It runs locally and sends nothing anywhere.

## Part of the code-health suite

locality is one of four plugins in the [code-health suite](https://github.com/dave-hillier-co/code-health), which finds where code is expensive to change, guides an agent through fixing it, and measures whether later changes got cheaper.

| Plugin | Question |
|---|---|
| [cochange](https://github.com/dave-hillier-co/code-health/tree/main/plugins/cochange) | Where does change effort concentrate, and what changes together? |
| [complexity](https://github.com/dave-hillier-co/code-health/tree/main/plugins/complexity) | Which functions are hard to understand, and where does the complexity come from? |
| [structure](https://github.com/dave-hillier-co/code-health/tree/main/plugins/structure) | Which dependencies make change expensive? |
| **locality** | Which code lives far from the code that uses it? |

Each plugin installs separately and none needs another. They share one config file, `code-health.json`, and one cache, `.cache/code-health/`, and each reads the others' stored results when they exist. A whole-repository run of `locality analyse` on a clean tree stores its results for the other plugins, `locality history refresh` builds the shared history cache in a repository without cochange installed, and the structure skill hands misplaced symbols to the `locality` skill.

## Skill

`locality` covers finding distant code, judging whether a folder such as `utils` is worth keeping, choosing between a move, an inline and a split, making the move, and measuring whether a tidy-up reduced import distance.

## Commands

Run the CLI as `node <plugin folder>/dist/locality.mjs <command>`. It prints a table in a terminal and JSON with `--json` or when piped. `--help` lists every command and its options.

| Command | Prints or does |
|---|---|
| `analyse` | Ranks the code that lives far from its consumers, with a default remedy for each unit. |
| `scrutinise` | Reviews the widely used units: the red flags their interfaces and call sites show, with the counts behind each. |
| `move` | Plans, or with `--apply` makes, the move of one unit: file moves and import rewrites, as one move-only commit. |
| `verify-move` | Checks that a commit made by hand reproduces the planned move of one unit, and changes nothing else. |
| `update-namespaces` | After a C# move commit, plans or with `--apply` makes the optional second commit that makes namespaces follow the folders. |
| `measure` | Records a baseline before a tidy-up, compares against it afterwards, or prints how a branch changes the total import distance. |
| `history` | Updates the shared history cache. |
| `report` | An HTML or Markdown page: `locality` (the top candidates with a dry-run move plan) or `trends` (import distance of the repository and its folders over sampled revisions). |

`explain <rule>` describes a recommendation rule, and `config explain` prints the effective config and where each value came from.

## Languages

Resolved dependencies and deterministic moves cover TypeScript and JavaScript, C#, C++, Python, Go, Java, Kotlin and Rust. The external tools that confirm a move (a language server, rope) are used when installed and never required. See [languages.md](https://github.com/dave-hillier-co/code-health/blob/main/docs/languages.md).

## Install

```
/plugin marketplace add dave-hillier-co/code-health
/plugin install locality@code-health
```

Requires Node 22.13 or later and git, with a full clone: a shallow clone has truncated history. The plugin has no other dependencies and needs no `npm install`.

## Licence

Dual-licensed under `AGPL-3.0-only` or a commercial licence. See [LICENSING.md](https://github.com/dave-hillier-co/code-health/blob/main/LICENSING.md).
