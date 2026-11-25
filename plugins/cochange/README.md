# cochange

Mines git history to show where change effort concentrates and which files change together, and briefs an agent on what usually changes with a file before it edits. It reads history only, so it works for every file in every language. It runs locally and sends nothing anywhere.

## Part of the code-health suite

cochange is one of four plugins in the [code-health suite](https://github.com/dave-hillier-co/code-health), which finds where code is expensive to change, guides an agent through fixing it, and measures whether later changes got cheaper.

| Plugin | Question |
|---|---|
| **cochange** | Where does change effort concentrate, and what changes together? |
| [complexity](https://github.com/dave-hillier-co/code-health/tree/main/plugins/complexity) | Which functions are hard to understand, and where does the complexity come from? |
| [structure](https://github.com/dave-hillier-co/code-health/tree/main/plugins/structure) | Which dependencies make change expensive? |
| [locality](https://github.com/dave-hillier-co/code-health/tree/main/plugins/locality) | Which code lives far from the code that uses it? |

Each plugin installs separately and none needs another. They share one config file, `code-health.json`, and one cache, `.cache/code-health/`, and each reads the others' stored results when they exist. With complexity and structure installed, the `change-risk` skill passes their `diff` and `check` output to `cochange risk` as evidence, and `cochange report overview` shows the top results of each plugin.

## Skills

| Skill | Use |
|---|---|
| `cochange` | Hotspots, temporal coupling, change spread, fix counts, and a briefing before an edit. |
| `change-risk` | How much a branch or pull request puts at risk, how to review it and who should review it. |
| `abandonment` | Knowledge lost when people leave. Off until the repository sets `cochange.knowledge.enabled`. |
| `identities` | A reviewed `.mailmap` that maps the names and emails people commit under to one identity each. |

## Commands

Run the CLI as `node <plugin folder>/dist/cochange.mjs <command>`. It prints a table in a terminal and JSON with `--json` or when piped. `--help` lists every command and its options.

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

`refresh` and `blame` update the shared caches. `explain <rule>` describes a recommendation rule, and `config explain` prints the effective config and where each value came from.

## People

Default outputs contain no author identities. The knowledge analysis is off until `cochange.knowledge.enabled` is set, models random turnover only, and never ranks or predicts individuals.

## Install

```
/plugin marketplace add dave-hillier-co/code-health
/plugin install cochange@code-health
```

Requires Node 22.13 or later and git, with a full clone: a shallow clone has truncated history. The plugin has no other dependencies and needs no `npm install`.

## Licence

Dual-licensed under `AGPL-3.0-only` or a commercial licence. See [LICENSING.md](https://github.com/dave-hillier-co/code-health/blob/main/LICENSING.md).
