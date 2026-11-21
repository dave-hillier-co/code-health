---
name: structure
description: Use when modules import each other in a cycle, when a dependency points from stable code towards code that changes often, when asked how to break, invert or untangle a dependency between folders, packages or components, when deciding why a change to one module keeps forcing a change in another, or when asked how a codebase already keeps its modules apart (events, injection, interfaces, callbacks) before adding more. Finds import cycles with minimal breaking sets and dependencies against stability, inventories the decoupling mechanisms already in use, builds an evidence pack for each problem dependency, and guides the agent from the evidence to the least machinery that works, asking before introducing any new mechanism.
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/structure.mjs *)
---

# Structure

A dependency is expensive when changing one side forces a change in the other. This skill finds the dependencies that cost the most (import cycles, and dependencies pointing from stable code towards volatile code), gathers the facts about each, and reasons from them to a remedy. The CLI reports facts and never edits. You choose the remedy, say why, and make each break its own commit.

The evidence outranks convention. Change evidence (what actually changed together) outranks structure (what imports what).

## Run the CLI

```
node ${CLAUDE_PLUGIN_ROOT}/dist/structure.mjs cycles --json
node ${CLAUDE_PLUGIN_ROOT}/dist/structure.mjs stability --json
node ${CLAUDE_PLUGIN_ROOT}/dist/structure.mjs census --json
node ${CLAUDE_PLUGIN_ROOT}/dist/structure.mjs coupling --json
node ${CLAUDE_PLUGIN_ROOT}/dist/structure.mjs evidence "src/a.ts->src/b.ts" --json
```

Run them from the repository root. They analyse `HEAD`. Useful options:

- `cycles --level file|folder|package` chooses what a cycle is made of. Start with `file`, then `folder`.
- `stability --by folder|component` lists dependencies that point against stability.
- `census` lists the decoupling mechanisms the codebase already uses, with counts, folders and examples. It reads no history. Run it before choosing a remedy: it is how you know what is already here and what would be new.
- `layers` lists imports that break the layer rules in `code-health.json` (`layers`), with the symbols that cross. `check [--base REV]` exits 1 on cycles or layer violations new since the base and reads no history, so it suits CI.
- `coupling [--quadrant Q] [--by file|folder|component]` places each pair as real, incidental, stable, hidden, independent or insufficient-evidence from static coupling and co-change. `hidden` lists only the hidden pairs, where code changes together with no import between it.
- `hubs` lists registration hubs: files that many features append to. Read `references/registration-hubs.md` before proposing an inversion.
- `outcome FROM->TO --at REV` compares co-change before and after a break, and says whether it was broken or only hidden.
- `evidence EDGE|FINDING` takes an edge as `from->to` (files, folders or components) or a finding id from `cycles`, `stability` or `layers`, and prints the full evidence pack.
- `--limit <n|all>` and `--fields` keep output small. `explain <rule>` describes a rule, and `config explain` shows the effective settings.

Read the envelope before the rows. The top-level `evidence.grade` is how far to trust history: with `weak`, rely on the static signals and present co-change as tentative. `inputs.locality` names the locality report that ranked the cycles, and is null when none was usable, in which case cycles are ranked by size and co-change alone.

Questions about whether the packages themselves are the right ones (too many, a boundary in the wrong place, whether to add a package) belong to the packaging skill, which reads the same graph at package level and adds cohesion evidence. `cycles --level package` here groups files by their nearest `package.json`. The packaging skill's `packages coupling` reads packages from every manifest and adds hidden cycles.

The census covers TypeScript and JavaScript only: for any other language, search the code for the mechanisms listed in `references/mechanisms.md` and say that you did.

## Read the evidence pack

`references/evidence-pack.md` explains each field. The ones that decide most breaks:

- `breakingSet` lists the symbols used across the edge. Many cycles come down to one or two symbols used in the wrong direction.
- `misplacement` says whether the consumers of a breaking-set symbol mostly sit on the other side. If they do, the symbol is in the wrong place.
- `stability` and `coChange` say which side changes and whether the two change together.
- `unblocks` lists locality moves this dependency is holding back, with the gain each would unblock.
- `nearbyMechanisms` lists census entries in or next to the two modules, nearest first. It is a view of the census (`references/mechanisms.md`), not the whole of it: a mechanism missing from the pack may still be in use further away, so read `census` before concluding that something is new.

## Reason to a remedy

Work through these questions in order and state your answer to each. They guide, they are not a decision table. `references/remedies.md` has the detail.

1. **Is the dependency real?** Remove dead imports and types imported for convenience. If `misplacement` shows the symbol belongs on the other side, moving it is usually the whole fix and adds no machinery. Hand that to the locality skill if it is installed.
2. **What is the coupling about?** High co-change means the two sides share a design decision: hiding it behind indirection keeps the cost and loses navigability, so put the decision in one place or accept the dependency and fix its direction. Low co-change with both sides active means the dependency is incidental and can be cut cheaply. Low co-change because the depended-on side never changes is a stable dependency: leave it alone.
3. **Which way should it point?** Towards the more stable side, by change evidence.
4. **How does this codebase already do it?** Read `census` and the evidence pack's `nearbyMechanisms`. Prefer the mechanism already used nearest the boundary (callbacks, interfaces implemented elsewhere, injection, events, handlers, registries), and when several are used, the one closest to it. Consistency with local patterns is worth more than the textbook choice. A census that finds nothing is an answer: nothing is already here to follow.
5. **What is the least machinery that works?** Consider in this order: moving the symbol, passing a value or a callback, an interface owned by the stable side, and only then indirection through events, mediators or registries. The order is for considering options, not a rule. Indirection removes a static dependency at the price of discoverability, and agents navigate by references.
6. **Does it introduce something new?** Compare the mechanism you would choose with the census. If its row is zero, or it is used only in folders far from this boundary, it is new here: stop and ask the user before writing any of it. Give the alternatives you weighed, including moving the symbol and passing a value or callback, and the evidence for each. New infrastructure is a team decision. Never default to a named pattern.

## Ask before introducing a mechanism

Do not edit anything for a new mechanism until the user has agreed. Put the question in one message:

- The dependency, and what the evidence says about it (co-change, stability, the breaking-set symbols).
- What the census shows: the mechanisms in use and where, and that the one you would choose is absent or far away.
- The options you weighed, simplest first, each with what it would cost here. Include the option that adds nothing (move, pass a value or callback, or accept the dependency and fix its direction).
- Which you would pick and why, and that you will not start until they agree.

`references/patterns.md` has background on each named mechanism: when it fits and what it costs. Use it to describe an option fairly, never to justify one the evidence does not support. A named pattern is not an answer by itself, and a user asking "which pattern?" gets the evidence and the options, not a pattern name.

## Apply one break per commit

- One refactoring per commit, tests green before and after: a move, or a dependency inversion, never both together.
- Re-run `cycles` after each break. Breaking one edge changes the cycle, and the breaking set you started with may no longer be the right one.
- Put the evidence in the commit body: the remedy, the alternatives considered, the figures behind the choice, and any red flag by name (see `references/red-flags.md`). End with the trailer that keeps the commit out of outcome windows, in the final paragraph of the message:

```
Code-Health: structure <the remedy, such as move or pass-callback>
```

## Check it worked

A break succeeded only if change got cheaper, not because the import went away. After a while, compare co-change between the two sides over matching windows with `evidence`. A broken cycle whose co-change is unchanged is **hidden, not broken**: the dependency was moved behind indirection and the coupling remains. Say so as evidence that the remedy treated the symptom. The cycle count is a leading indicator only. State sample sizes and say what the evidence does not show.
