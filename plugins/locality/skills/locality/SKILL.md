---
name: locality
description: Use when code is hard to follow because it lives far from the code that uses it, before tidying or reorganising folders, when a utils, helpers or common folder has grown, when a change means opening many distant files, or when asked whether a helper, wrapper, barrel file or shared module is worth keeping, moving, inlining or splitting. Finds TypeScript and JavaScript code far from its consumers, recommends a remedy for each unit, and guides the agent through the moves and inlines one commit at a time.
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/locality.mjs *)
---

# Locality

Distant code costs every reader a hop, and an agent pays for each hop in files opened and tokens read. This skill finds code that sits far from its consumers and decides, with evidence, whether to move it closer, inline it, split it, or leave it. It never creates helpers or abstractions.

The CLI computes facts and default recommendations. You supply judgement, make the edits, and record every override with its reason.

## Run the analyser

```
node ${CLAUDE_PLUGIN_ROOT}/dist/locality.mjs analyse --json
```

Run it from the repository root. It analyses `HEAD` and never edits code. Useful options:

- `--limit <n|all>` and `--fields path,recommendation,rule,target,gain,fanIn` keep the output small. The default is 20 rows.
- `--recommendation inline|move|split|blocked|keep|scrutinise|review` lists one kind.
- Path arguments (`analyse src/shared`) limit the run to units under those paths.
- `--source history` analyses co-change alone, for languages with no structural adapter: moves and reviews only, on moderate or strong evidence. `--source both` adds `hiddenCoupling`, units the import graph places well whose co-change partners are all elsewhere.
- `explain <rule>` describes any rule named in a result, and `config explain` shows the effective settings.

A whole-repository run on a clean tree also stores every result in `.cache/code-health/reports/locality.analyse.json`, which other plugins read.

Read the envelope before the rows:

- `inputs.entrySource` is `config` when the repository's `code-health.json` lists `entryPoints`, and `detected` when the CLI treated every file nothing imports as an entry. Detected entries are a guess. If the repository has dynamic entry points (a DI container, a plugin registry, framework file conventions), ask the user for them and add them to `entryPoints` before trusting the results.
- `unreachable` lists files no entry point reaches. They are dead code or a missing entry point, and they take no part in the analysis.
- `filesWithSyntaxErrors` and `unresolved` say where the graph may be incomplete. Say so when a recommendation rests on one of those files.

## Read a candidate

Each row is a unit: a file, a branch (a file plus everything only it imports), or a sibling set (files that share internals, named by their folder).

- `rule` names what fired. `recommendation` is the default for it: `inline`, `move`, `split`, `blocked`, `scrutinise`, `review` or `keep`.
- `location`, `target`, `distance` and `gain` say where the unit is, where net distance is lowest, and how much distance the move saves. Net distance counts the unit's own dependencies as well as its consumers, so a unit is not pulled away from what it depends on.
- `fanIn`, `directCalls` and `otherRefs` say who uses it. `testRefs.owned` are tests that move with the unit.
- `age`, `lastChanged`, `churn` and `coChange` come from the history cache and are null without it (`locality history refresh` builds it; `analyse` refreshes it itself).
- `signals` name red flags the CLI saw: `pass-through`, `vague-name`, `overexposure`, `special-general-mixture`, `barrel`.
- `blockers` and `strays` are the edges that hold a move back, each with the gain it would unblock.
- `cohesion.components` shows, for a file, which exports belong together and who uses each group.

`references/recommendations.md` has the full rule table and what to check before acting on each one.

## Decide

Treat each recommendation as a default to confirm or override. Before acting:

1. Name the red flag you judge present (see `references/red-flags.md`), or say that none applies. A candidate with no red flag and no evidence of cost is a candidate to dismiss.
2. Open the unit and its consumers. Confirm the counts by reading the call sites. If an LSP server is available, use find-references too.
3. Apply the judgement the rules cannot:
   - A helper that encodes a domain rule needing one source of truth stays, however small.
   - A name that explains the code better than the code does can justify a move instead of an inline.
   - A unit with its own direct tests may be a deliberate seam.
   - At three or more consumers, ask whether they share a reason to change. `coChange.amongConsumers` is the median co-change degree between them, and the `consumers-co-change` and `independent-consumers` rules already act on it. When it is null the history gave too little, so read the git log of the consumers together before moving or inlining. Under a `weak` `history.grade`, treat history-based fields as tentative and do not let them overturn a static recommendation.
4. Skip or defer units that are changing now. Check `git log --since` on the unit and its consumers, and leave anything with open work. Old, stable units are the cheapest moves.
5. Units younger than `locality.graceDays` (90 by default) are weak evidence for `inline` and `move`: one callsite is only evidence once reuse has had time to happen. The analyser applies this as the `within-grace-period` rule using `age`. Its `creates-cycle` rule refuses a move that would make two folders import each other. The checks it does not make for you: an interface, an override or a recursive function is not a free-standing helper, so read the unit before inlining it.

`scrutinise` units are not moved. Review them with `locality scrutinise` and `references/scrutinise.md`. `blocked` units need a blocker resolved first: see `references/blocked-moves.md`.

## Apply one unit per commit

Every commit is a single, revertible step with the tests green before and after. A reviewer never evaluates a move and a behaviour change together.

- **Split first.** A `split` is its own commit: move each export group to a new sibling file, rewrite imports, change nothing else. The resulting units are then moved or inlined in later commits. Re-run the analyser afterwards, because the graph changed.
- **Move second, with the mover.** A move commit contains only the file moves and the import rewrites that follow. `locality move` plans and makes it deterministically, keeping the unit's layout and carrying its owned tests, so git's rename detection keeps history intact. Always run it as a dry run first and show the planned file operations to the user before `--apply`. See "Move with the mover" below.
- **Inline third, in its own commit.** Substitute parameters, watch for name collisions, side-effect order and early returns, then delete the unit and its owned tests only if the caller's tests cover the behaviour.
- **Leaves before roots.** For nested units, the smallest land first, then re-analyse. A branch rooted above scattered files (`scattered-unit`) is handled by moving its leaves.
- **Never move across published package boundaries.** `package-entry` and `fixed-point` mean flag it and stop.
- **Run the project's own checks** (type check, tests, lint) between commits. If they fail after a move, fix the import rewrite, not the tests.

### Move with the mover

```
node ${CLAUDE_PLUGIN_ROOT}/dist/locality.mjs move src/shared/utils/money.ts --json
```

This is a dry run. It changes nothing and reports:

- `results`: the exact file operations (`from`, `to`, and `role` `unit` or `test`).
- `rewrites`: every import specifier it would change, with file and line. Specifiers keep the extension style the repository writes (`.ts`, `.js` or none).
- `refusals`: why it will not move the unit. Guards (`package-entry`, `fixed-point`, `fixed-point-destination`, `package-boundary`, `collision`, `barrel`, `no-change`, `invalid-destination`) cannot be overridden. Stop and report them.
- `mentions`: files outside the source (docs, config, scripts) that name a moved path. The mover does not edit them. Update them yourself in the same commit, or say why not.
- `warnings`: an import that could not be repaired, or an alias that became a relative path. Read each one.

Show the operations and rewrites to the user, then apply:

```
node ${CLAUDE_PLUGIN_ROOT}/dist/locality.mjs move src/shared/utils/money.ts --apply
```

`--apply` needs a clean working tree, makes the moves with `git mv`, rewrites the imports and commits the lot as one move-only commit whose message records the rule, the consumer count, any red flag and the `Code-Health:` trailer. `--no-commit` leaves it staged, for when you must add the mention fixes before committing. Then run the project's checks.

- `--to <folder>` chooses a destination other than the analyser's target. Say why in your report.
- A unit whose recommendation is not `move` is refused with `needs-reason` until you pass `--reason "<why>"`. The reason goes in the commit message as the override. Use it only for a judgement the rules cannot see, such as a name that explains the code.
- Imports written as `jest.mock("...")`, string paths in config and generated files are not rewritten. The type checker and the tests are the check on those.

When the mover cannot do what is needed (a path you must place by hand, or a language it does not cover), make the move yourself with `git mv` and your editor's rename refactoring, in a move-only commit with the `Code-Health:` trailer, then prove it reproduces the plan:

```
node ${CLAUDE_PLUGIN_ROOT}/dist/locality.mjs verify-move src/shared/utils/money.ts
```

`verify-move` plans the move from the code before the commit (`--commit <ref>` to check another commit, `--to <folder>` if you chose another destination) and checks that every planned file moved, nothing else was added or removed, every file holds the text the mover would have written, and the message carries the trailer. It exits 1 and lists what differs: `missing` operations, `unexpectedAdded` or `unexpectedDeleted` files, `specifierDifferences` (an import spelled differently from the mover's, with expected and actual) and `otherChanges` (a change that is not an import path, so the commit is not move-only). Fix the commit and verify again. `references/moving.md` has the details.

### Commit message

When you commit by hand, record the evidence in the body: the rule that fired, the consumer count, any red flag cited, and any override of the default with its reason. End with the trailer that keeps the commit out of outcome windows, in the final paragraph of the message:

```
Move the money formatter next to its consumers

Rule two-consumers: used by orders/place.ts and billing/charge.ts, target src.
Red flag: vague name (utils).

Code-Health: locality two-consumers
```

## Report honestly

State sample sizes and say what the evidence does not show. The analyser's gain is a leading indicator, not an outcome: a unit that moved closer has not yet made anything cheaper to change. Agent effort over later tasks is the outcome. Take a baseline before the first move and compare afterwards with `measure`: see `references/measure.md`. Read `structure.gaming` in the compare result as well: a gain that came with more single-file folders or a deeper tree is buried code, not a tidy-up. Do not claim an improvement the data cannot show.

Do not move code to make the score better. If a target would bury code deeper than the configured `locality.maxDepth`, the analyser clamps it, and you should not work around that.

## Configuration

Settings live in the `locality` section of `code-health.json`, with `exclude`, `entryPoints` and `vagueNames` shared across the suite. `references/recommendations.md` lists them. Ask before changing thresholds to make a recommendation appear or disappear.
