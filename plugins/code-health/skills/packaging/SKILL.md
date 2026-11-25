---
name: packaging
description: Use when asked whether a codebase has too many packages, whether a package boundary is in the right place, whether two packages should be merged or one split, why every change touches several packages, why a shared or common package keeps growing, or before adding a new package, library, workspace or module. Reads package manifests, history and imports to find boundaries that cost more than they give, names the packages to merge, split, reshape or leave, with the evidence, asks what each leading package is for before judging it, and measures whether a repackaging made change cheaper.
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/structure.mjs *)
---

# Packaging

A misplaced file costs a reader a hop. A misplaced package boundary costs a version, a build step, a published interface, and a change that has to be made in two places and released in order. Packages are easy to create and hard to remove, and they are usually created early from a guess about what will be reused. This skill tests each boundary against the evidence, as the locality skill tests each folder.

A package here is a unit the build delivers: a workspace package, a C# project, a CMake target, a Gradle or Maven module, a Python distribution, a Rust crate, a Go package (grouped under its module). It is not a folder. The CLI reports facts and never edits. You judge, say why, and make each step its own commit.

**Fewer packages is the default.** A boundary has to justify itself by reuse, by a declared purpose, or by change evidence. Splitting needs evidence of disjoint reuse or independent change, never anticipation.

## Run the CLI

```
node ${CLAUDE_PLUGIN_ROOT}/dist/structure.mjs packages list --json
node ${CLAUDE_PLUGIN_ROOT}/dist/structure.mjs packages candidates --json
node ${CLAUDE_PLUGIN_ROOT}/dist/structure.mjs packages evidence "packages/ui->packages/api" --json
```

Run them from the repository root. They analyse `HEAD`. The subcommands:

- `list`: every package with its kind (internal or published), declared purpose, consumers, `Ca`, `Ce`, instability `I`, abstractness `A`, distance `D`, closure beside its share of changes, and change frequency, the largest share of changes first. `published` means only that nothing marks the package internal: `kindSource: default` says no manifest marker (`publish = false`, `"private": true`, `IsPackable` false) and no config entry does, so it is a guess to confirm with the user. `repository.unowned` counts the files no package owns, such as documentation and a website beside a root crate: changes to them count for no package.
- `cohesion [PACKAGE]`: the closure, reuse and release findings, and for each package the balance between the three forces. Rows below their guideline (`low-closure`, `always-together`, `follower`, `crossing-unit`, `partial-use`, `disjoint-reuse`, `overexposed`, `pass-through-package`, `tiny`) are listed last, with `aboveGuideline: false` and the shortfall at the end of the summary. They feed no candidate and no balance.
- `coupling`: package cycles, hidden cycles, dependencies against stability, the zones, volatile interfaces. Rows below their guideline are listed last, with `aboveGuideline: false`.
- `boundaries [PACKAGE]`: deep imports, undeclared and unused dependencies, purpose mismatches. It prints a notice for each ecosystem and check it does not support, so a missing finding there says nothing.
- `candidates [--kind merge|split|move-unit|narrow-interface|fix-manifest|break-dependency]`: the findings combined into proposals, ranked by the recency-weighted changes that crossed the boundary in question.
- `evidence PACKAGE` or `evidence A->B`: the full facts for one package or one pair: co-change, shared changes, reuse profile, export components. For a `break-dependency` candidate, run its `handoff` instead: `structure evidence "A->B" --level package`, which is `node ${CLAUDE_PLUGIN_ROOT}/dist/structure.mjs evidence "A->B" --level package --json`, the evidence pack the structure skill reads.
- `check [--base REV]`: exits 1 on package cycles, deep imports or undeclared dependencies added since a base revision.
- `outcome REV [--from REV] [--projects-dir DIR]`: whether a repackaging made change cheaper.
- `explain <finding>` describes a finding and its guidelines. `config explain` shows the settings under `structure.packages`.

Read the envelope first. `evidence.grade` says how far to trust history: with `weak`, lean on the manifests and imports and present co-change as tentative. A finding with `tentative: true` involves a package inside the grace period (180 days by default), which has had no time to be reused. A package listed under `unavailable` is one the structural layer cannot read (its language has no adapter): its closure and co-change findings stand, its reuse and boundary findings do not exist, and you must say so rather than call it clean.

## Workflow

1. **Orient.** Run `list` and `candidates`. Both print 20 rows by default: the packages with the largest share of changes, and the candidates that address the most change cost. `--limit all` prints every row. Do not ask about every package: a large repository has too many. Read only the leading candidates, which are ranked by the change cost they address.
2. **Capture purpose.** For the packages in the leading candidates, ask the user whether each is published (consumers outside this repository) and what it is for: `reuse`, `deploy`, `ownership`, `build` or `enforcement`. Evidence can show that a package is not reused. It cannot show that it was never meant to be. Record the answers in `code-health.json` under `structure.packages.byPackage` (see `references/purpose.md`), then run `candidates` again. A candidate cannot be judged without them. Published packages are never changed, and the CLI withholds candidates that would. A `withheld` entry with a `question` is withheld only because nothing marks a package internal: put the question to the user with the `candidate` it holds, and do not report it as settled.
3. **Present a few.** Show the candidates that address the most change cost, each with the principle it serves and the principle it costs (`references/principles.md`), the figures, and any `against` entries. A `blocked` candidate is one the tool's own findings would reverse (a merge whose result would be disjoint-reuse, a split whose parts change together, a move that closes a cycle): say why and do not propose it.
4. **Reason through the ones the user wants.** Run `packages evidence` and answer, in the open:
   - *Is the boundary earning anything?* Reuse, a declared purpose the evidence supports, or independent change.
   - *What would the result look like?* A merge that produces a package with disjoint consumers trades a common closure problem for a common reuse problem.
   - *Which force matters here?* By the package's change rate, consumer count and age. A package that changes often with one or two consumers is paying for a boundary and getting nothing back, so closure matters most. A package that rarely changes with many consumers has earned its boundary, so the question is whether consumers carry parts they do not need. A young package is tentative.
   - *Is there a cheaper fix?* Moving one crossing unit, or narrowing an interface, often removes most of the cross-boundary change without repackaging anything.
5. **Propose the smallest step.** In order of preference: fix manifests, move a unit, narrow an interface, merge, split. Say what you considered and why the smaller steps do not work.
6. **Baseline before the first step.** Save `packages list --json` and note the commit. `references/measurement.md` says what to compare afterwards.
7. **Apply in single-refactoring commits**, build and tests green after each (`references/candidates.md`). A merge is one commit that moves the files and rewrites the imports together, since the build is broken between the two, then a second that removes the emptied package's manifest. A split or a move is one commit each. End each commit message with the trailer that keeps it out of outcome windows, in the final paragraph:

```
Code-Health: packaging <the step, such as merge, move-unit, narrow-interface or fix-manifest>
```

Put the evidence in the commit body: the findings by id, the figures, the principle served and the one it costs, the alternatives, and any red flag by name. Re-run `candidates` after each step: it changes the findings the next one rests on.

## When asked to add a package

Apply the same tests in advance, before creating anything. Ask:

- **Who is the second consumer?** A package with one consumer is reused by nothing. Name the consumer, or the evidence that one is coming.
- **Does the code change independently of its current home?** Look at `packages cohesion` and `evidence` for the package it lives in now: do these files change with their neighbours, or apart from them?
- **What purpose would be declared?** Reuse, deploy, ownership, build time or enforcement. If it is ownership, build or enforcement, say so and who asked for it.

Without an answer to one of them, the default is a folder, which costs nothing to promote later. Say that, and do not create the manifest. If the user answers all three, record the declared purpose and create the package.

## Vocabulary

Name problems with the red flags in `references/red-flags.md`. A `pass-through-package` is a *shallow module*. A `follower` is *information leakage*. `overexposed` is *overexposure*. Layer-shaped packages (`ui`, `domain`, `data`) that always change together are the structural cousin of *temporal decomposition*. The six principles behind the findings are in `references/principles.md`: they pull against one another, so show which force a package serves and which it neglects, never a score.

## What this CLI does not do

- It does not edit anything, and it does not choose between a candidate's alternatives. It cannot see build time, which is often the real reason for or against a package, so ask.
- Reuse, deep import and manifest checks need the structural layer, which reads TypeScript, JavaScript, C#, C++, Python, Java, Kotlin, Go and Rust. For a package in any other language it reads the manifest only: the dependency graph, closure, co-change, lockstep and wide-change findings still apply.
- `abstractness` is weak where little is declared abstract, as in code that is mostly functions. The finding says so, and the change evidence carries the judgement.
- Evidence beats convention. A package diagram is a hypothesis, and a package in the zone of pain that never changes is not in pain.

To write a report (`report <kind>`), the CLI renders the page and you write only the judgement slots: follow [references/reports.md](references/reports.md).
