---
name: structure
description: Use when modules import each other in a cycle, when a dependency points from stable code towards code that changes often, when asked how to break, invert or untangle a dependency between folders, packages or components, or when deciding why a change to one module keeps forcing a change in another. Finds import cycles with minimal breaking sets and dependencies against stability, builds an evidence pack for each, and guides the agent from the evidence to the least machinery that works, asking before introducing any new mechanism.
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/structure.mjs *)
---

# Structure

A dependency is expensive when changing one side forces a change in the other. This skill finds the dependencies that cost the most (import cycles, and dependencies pointing from stable code towards volatile code), gathers the facts about each, and reasons from them to a remedy. The CLI reports facts and never edits. You choose the remedy, say why, and make each break its own commit.

The evidence outranks convention. Change evidence (what actually changed together) outranks structure (what imports what).

## Run the CLI

```
node ${CLAUDE_PLUGIN_ROOT}/dist/structure.mjs cycles --json
node ${CLAUDE_PLUGIN_ROOT}/dist/structure.mjs stability --json
node ${CLAUDE_PLUGIN_ROOT}/dist/structure.mjs evidence "src/a.ts->src/b.ts" --json
```

Run them from the repository root. They analyse `HEAD`. Useful options:

- `cycles --level file|folder|package` chooses what a cycle is made of. Start with `file`, then `folder`.
- `stability --by folder|component` lists dependencies that point against stability.
- `evidence EDGE|FINDING` takes an edge as `from->to` (files, folders or components) or a finding id from `cycles` or `stability`, and prints the full evidence pack.
- `--limit <n|all>` and `--fields` keep output small. `explain <rule>` describes a rule, and `config explain` shows the effective settings.

Read the envelope before the rows. The top-level `evidence.grade` is how far to trust history: with `weak`, rely on the static signals and present co-change as tentative. `inputs.locality` names the locality report that ranked the cycles, and is null when none was usable, in which case cycles are ranked by size and co-change alone.

Questions about whether the packages themselves are the right ones (too many, a boundary in the wrong place, whether to add a package) belong to the packaging skill, which reads the same graph at package level and adds cohesion evidence. `cycles --level package` here groups files by their nearest `package.json`. The packaging skill's `packages coupling` reads packages from every manifest and adds hidden cycles.

What this CLI does not do yet: layer rules, the mechanism census, coupling quadrants, hidden coupling, registration hubs and `check` are not commands, and the evidence pack's `quadrant`, `nearbyMechanisms` and `layerRule` are empty. Where a question below needs them, find the facts by reading the code and the git log, and say that you did.

## Read the evidence pack

`references/evidence-pack.md` explains each field. The ones that decide most breaks:

- `breakingSet` lists the symbols used across the edge. Many cycles come down to one or two symbols used in the wrong direction.
- `misplacement` says whether the consumers of a breaking-set symbol mostly sit on the other side. If they do, the symbol is in the wrong place.
- `stability` and `coChange` say which side changes and whether the two change together.
- `unblocks` lists locality moves this dependency is holding back, with the gain each would unblock.

## Reason to a remedy

Work through these questions in order and state your answer to each. They guide, they are not a decision table. `references/remedies.md` has the detail.

1. **Is the dependency real?** Remove dead imports and types imported for convenience. If `misplacement` shows the symbol belongs on the other side, moving it is usually the whole fix and adds no machinery. Hand that to the locality skill if it is installed.
2. **What is the coupling about?** High co-change means the two sides share a design decision: hiding it behind indirection keeps the cost and loses navigability, so put the decision in one place or accept the dependency and fix its direction. Low co-change with both sides active means the dependency is incidental and can be cut cheaply. Low co-change because the depended-on side never changes is a stable dependency: leave it alone.
3. **Which way should it point?** Towards the more stable side, by change evidence.
4. **How does this codebase already do it?** Search for the mechanism the code already uses near the boundary (callbacks, interfaces implemented elsewhere, injection, events, handlers, registries) and prefer it. Consistency with local patterns is worth more than the textbook choice.
5. **What is the least machinery that works?** Consider in this order: moving the symbol, passing a value or a callback, an interface owned by the stable side, and only then indirection through events, mediators or registries. The order is for considering options, not a rule. Indirection removes a static dependency at the price of discoverability, and agents navigate by references.
6. **Does it introduce something new?** If the mechanism you would choose is not already in the codebase, stop and ask the user. Give the alternatives you weighed and the evidence for each. New infrastructure is a team decision. Never default to a named pattern.

## Apply one break per commit

- One refactoring per commit, tests green before and after: a move, or a dependency inversion, never both together.
- Re-run `cycles` after each break. Breaking one edge changes the cycle, and the breaking set you started with may no longer be the right one.
- Put the evidence in the commit body: the remedy, the alternatives considered, the figures behind the choice, and any red flag by name (see `references/red-flags.md`). End with the trailer that keeps the commit out of outcome windows, in the final paragraph of the message:

```
Code-Health: structure <the remedy, such as move or pass-callback>
```

## Check it worked

A break succeeded only if change got cheaper, not because the import went away. After a while, compare co-change between the two sides over matching windows with `evidence`. A broken cycle whose co-change is unchanged is **hidden, not broken**: the dependency was moved behind indirection and the coupling remains. Say so as evidence that the remedy treated the symptom. The cycle count is a leading indicator only. State sample sizes and say what the evidence does not show.
