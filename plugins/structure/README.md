# structure

Finds the dependencies that make change expensive: import cycles with their smallest breaking sets, imports that break layer rules, and dependencies pointing from stable code onto volatile code, with an evidence pack for each. A second skill judges whether the packages are the right ones. It runs locally and sends nothing anywhere.

## Part of the code-health suite

structure is one of four plugins in the [code-health suite](https://github.com/dave-hillier-co/code-health), which finds where code is expensive to change, guides an agent through fixing it, and measures whether later changes got cheaper.

| Plugin | Question |
|---|---|
| [cochange](https://github.com/dave-hillier-co/code-health/tree/main/plugins/cochange) | Where does change effort concentrate, and what changes together? |
| [complexity](https://github.com/dave-hillier-co/code-health/tree/main/plugins/complexity) | Which functions are hard to understand, and where does the complexity come from? |
| **structure** | Which dependencies make change expensive? |
| [locality](https://github.com/dave-hillier-co/code-health/tree/main/plugins/locality) | Which code lives far from the code that uses it? |

Each plugin installs separately and none needs another. They share one config file, `code-health.json`, and one cache, `.cache/code-health/`, and each reads the others' stored results when they exist. When an evidence pack shows a symbol belongs on the other side of a dependency, the `structure` skill hands the move to the locality skill if it is installed, and cochange's `change-risk` skill uses `structure check` as evidence for a branch.

## Skills

| Skill | Use |
|---|---|
| `structure` | Import cycles, layer violations, dependencies against stability, and how to break a dependency without adding machinery that hides it. |
| `packaging` | Whether a codebase has too many packages, whether a boundary is in the right place, and whether to merge or split packages. |

## Commands

Run the CLI as `node <plugin folder>/dist/structure.mjs <command>`. It prints a table in a terminal and JSON with `--json` or when piped. `--help` lists every command and its options.

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

`explain <rule>` describes a recommendation rule, and `config explain` prints the effective config and where each value came from.

## Languages

Resolved dependencies cover TypeScript and JavaScript, C#, C++, Python, Go, Java, Kotlin and Rust. See [languages.md](https://github.com/dave-hillier-co/code-health/blob/main/docs/languages.md).

## Install

```
/plugin marketplace add dave-hillier-co/code-health
/plugin install structure@code-health
```

Requires Node 22.13 or later and git, with a full clone: a shallow clone has truncated history. The plugin has no other dependencies and needs no `npm install`.

## Licence

Dual-licensed under `AGPL-3.0-only` or a commercial licence. See [LICENSING.md](https://github.com/dave-hillier-co/code-health/blob/main/LICENSING.md).
