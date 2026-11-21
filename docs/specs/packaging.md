# Packaging Skill — Spec

A second skill in the **structure** plugin. Read [suite.md](suite.md) and [structure.md](structure.md) first. This skill reuses structure's graph, cycles, stability and coupling quadrants, [locality](locality.md)'s cohesion analysis, and co-change from the shared history cache.

## Purpose

The skill judges whether a codebase's packages are the right ones: whether there are too many, whether each boundary sits where the code actually divides, and whether the dependencies between packages point the right way. It names the packages to merge, split or reshape, with the evidence, and measures whether changes got cheaper afterwards.

[Locality](locality.md) asks whether a file lives near the code that uses it. This skill asks the same question one level up, where the cost of a wrong answer is higher. A misplaced file costs a reader a hop. A misplaced package boundary costs a version, a build step, a published interface and a change that has to be made in two places and released in order.

Packages are easy to create and hard to remove. They tend to be created early, from a guess about what will be reused or a diagram of how the system ought to divide, and the guess is rarely revisited. The usual results are too many packages, a `shared` or `core` package that everything depends on and everyone edits, and boundaries that every feature has to cross. The skill tests each boundary against the evidence, as locality tests each folder.

## Basis

The frame is Robert C. Martin's six package principles, as he summarises them in [The Principles of OOD](http://butunclebob.com/ArticleS.UncleBob.PrinciplesOfOod). The one-line statements quoted below are his. The fuller treatment, with the metrics, is in *Agile Software Development: Principles, Patterns, and Practices* (2002), restated for components in *Clean Architecture* (2017).

Martin means a specific thing by a package: "a binary deliverable like a .jar file, or a dll as opposed to a namespace like a java package or a C++ namespace". This spec follows him. A package here is a unit the build system delivers, not a folder.

Three are about **cohesion**. In his words, "they tell us what to put inside packages":

- **REP, the Release Reuse Equivalency Principle.** "The granule of reuse is the granule of release." Code that is reused together should be released together, and something that is not reused has no reason to be a release unit.
- **CCP, the Common Closure Principle.** "Classes that change together are packaged together." A change should land in one package.
- **CRP, the Common Reuse Principle.** "Classes that are used together are packaged together." The books draw out the converse, which is where the cost lies: a consumer should not be made to depend on things it does not use.

Three are about **coupling**: "the couplings between packages", with "metrics that evaluate the package structure of a system":

- **ADP, the Acyclic Dependencies Principle.** "The dependency graph of packages must have no cycles."
- **SDP, the Stable Dependencies Principle.** "Depend in the direction of stability."
- **SAP, the Stable Abstractions Principle.** "Abstractness increases with stability."

The cohesion principles pull against each other, a tension Martin sets out in *Clean Architecture*. REP and CCP make packages larger. CRP makes them smaller. His point is that no package satisfies all three, and that the right balance moves as a project matures: early on, ease of change (CCP) matters most, and reuse (REP, CRP) earns its weight later. So the skill does not score a package against all three. It shows which force a package is serving, which it is neglecting, and what that neglect is costing.

The principles were stated without the evidence to test them. The suite has it: co-change is a direct measure of common closure, and consumer analysis is a direct measure of common reuse.

## Scope

In scope:

- Discovering packages and their declared dependencies from manifests.
- Cohesion evidence for each package: closure, reuse and release.
- Coupling evidence between packages: cycles, stability, abstractness and distance from the main sequence.
- Boundary quality: how often changes cross a boundary, and whether consumers respect it.
- Candidates to merge, split, move a unit across a boundary, or narrow an interface.
- Measuring whether a repackaging made change cheaper.

Out of scope:

- Applying a repackaging mechanically. Merging or splitting packages touches manifests, build configuration and release process. The agent performs it in steps, with the user's agreement.
- Changing **published** packages. Their consumers are outside the repository, so the evidence is incomplete. Findings are reported and nothing is proposed for action.
- Deployable boundaries. Which services exist is an operational decision. Co-change between deployables is reported as evidence, and merging them is not proposed.
- Cross-repository packages.

## Concepts

**Package.** The unit a build system or package manager treats as one: a workspace package, a C# project, a CMake target, a Gradle or Maven module, a Python distribution, a Rust crate. These are the *fixed points* in [suite.md](suite.md#language-notes), discovered from manifests. Where a repository has no such units, configured `components` stand in, and the same analysis applies.

**Internal and published.** A package is *published* when consumers outside the repository can depend on it. It is *internal* when its manifest says so (for example `private: true` in a workspace manifest) or config does. Where neither settles it, the package is treated as published, which is the safe mistake. Internal packages can be reshaped freely. Published ones cannot.

**Declared purpose.** Why a package exists, recorded in config: `reuse`, `deploy`, `ownership`, `build` (build time or caching), or `enforcement` (the boundary exists to stop a dependency). Evidence can show that a package is not reused. It cannot show that the package was never meant to be. A package with a declared purpose is judged against that purpose, and one without is judged as if its purpose were reuse.

**Closure.** For a package, the share of the logical changes touching it that touch no other package. High closure means changes stay inside. It is the direct measure of CCP. Closure rises with size for no other reason than size: a package holding half the repository keeps most changes inside it. So closure is always reported beside the package's share of the repository's changes, and judged against packages of comparable share, never against a fixed threshold.

**Package co-change.** Temporal coupling computed between packages, using cochange's definitions with packages as the units: degree, confidence in each direction, support, and the significance test from [structure](structure.md#concepts). A large package changes in most commits, so confidence towards it is high whatever the relation. Package confidence is therefore read as lift over the other package's base rate of change.

**Reuse profile.** For each consumer of a package, the share of the package's exported surface it uses. A package whose consumers each use most of it is reused as a whole. A package whose consumers use small, disjoint parts is several packages sharing a name.

**Export components.** Locality's file-cohesion graph, applied to a package's exported surface: link two exports when they share consumers or reference each other, and count the connected components.

**Instability.** Martin's metric from the books, `I = Ce / (Ca + Ce)`, over package dependencies, with change stability beside it, as in [structure](structure.md#concepts).

**Abstractness.** `A`, the share of a package's exported types that are abstract: interfaces, abstract classes, traits, protocols, pure-virtual classes and type-only declarations. It is a structural-layer metric with per-language definitions.

**Distance from the main sequence.** `D = |A + I − 1|`. A package near `A = 0, I = 0` is stable and concrete, the *zone of pain*: hard to change, and everything depends on it. A package near `A = 1, I = 1` is abstract and unused, the *zone of uselessness*.

## Heuristics

Each row is a deterministic finding. As elsewhere in the suite, a finding raises a question for review and never proves a fault.

### Common closure (CCP)

| Finding | Signal | Reading |
|---|---|---|
| `low-closure` | Closure in the lowest quartile among packages with a comparable share of changes, with enough changes to judge. Where fewer than five comparable packages exist, the finding is not raised and the count of crossing changes is reported instead. | Changes to this package usually need another package too. The boundary is in the wrong place, or there are too many. |
| `always-together` | Two packages with significant co-change and high lift in both directions | They are one unit of change, split in two. A candidate to merge. |
| `follower` | High confidence A→B and low B→A, where A depends on B | Changing A usually means changing B's interface. B's interface is not hiding what it should, or part of B belongs in A. |
| `crossing-unit` | A file or folder whose co-change partners are mostly in another package | A unit on the wrong side of the boundary. A candidate to move across. |
| `wide-change` | Share of logical changes touching three or more packages, as a repository trend | The packages cut across the features. This is layering by kind (`ui`, `domain`, `data`) at package level. |

### Common reuse (CRP)

| Finding | Signal | Reading |
|---|---|---|
| `partial-use` | Most consumers use a small share of the exported surface | Consumers are made to depend on things they do not use |
| `disjoint-reuse` | Two or more export components, with consumers that barely overlap | Several packages sharing a name. A candidate to split along the components. |
| `dumping-ground` | High fan-in, many export components, high change frequency and many contributors, typically named `shared`, `common`, `core` or `utils` | Coincidental cohesion at package level. Every change to it rebuilds and risks everything, and most consumers needed none of it. |
| `inherited-weight` | A consumer acquires heavy transitive dependencies through a package it uses only a part of, and that part does not need them | The cost CRP exists to prevent: a dependency paid for by code that does not use it |
| `overexposed` | Exports that no other package uses | The interface is wider than its consumers need. A candidate to narrow. |

### Reuse and release (REP)

| Finding | Signal | Reading |
|---|---|---|
| `single-consumer` | An internal package with one consuming package, past the grace period. Test-support packages and application entry points are excluded. | Nothing is being reused. Unless its declared purpose says otherwise, a candidate to merge into its consumer. |
| `no-consumer` | A package nothing depends on, that is not an entry point or a deployable | Dead, or an entry point missing from config |
| `lockstep` | Packages whose versions always change in the same commits, where that is a choice. Not raised where tooling or policy fixes it: one version for the whole repository, fixed or linked version groups, or internal packages with no real versions. | They are released as one unit already. Separate versions are ceremony. |
| `one-deployable` | A package that ships in only one deployable, in a repository with more than one | It has no release life of its own |
| `pass-through-package` | A package whose exports are mostly re-exports of another package's | A shallow module at package level. A candidate to remove. |
| `tiny` | Size in the lowest percentile of packages, with fixed overhead (manifest, build config, entry point) comparable to its content | The package costs more to have than it contains |

### Acyclic dependencies (ADP)

| Finding | Signal | Reading |
|---|---|---|
| `package-cycle` | A cycle in the package graph, with its breaking set, from `structure cycles --level package` | Neither package can be built, tested or released without the other |
| `hidden-cycle` | No cycle in the manifests, but a cycle through development dependencies or test-only imports | The build system forbids the cycle, so it has gone somewhere the build cannot see. Cycles through test code alone are reported at low priority. |

### Stable dependencies and stable abstractions (SDP, SAP)

| Finding | Signal | Reading |
|---|---|---|
| `against-stability` | A dependency from a package to one that changes more often than it does | The stable package is made to change with the volatile one |
| `zone-of-pain` | Low `A`, low `I`, **and** frequent change | Concrete, widely depended on and still changing: every change ripples. Stable concrete packages that rarely change (a string library) are healthy and are not flagged. |
| `zone-of-uselessness` | High `A`, high `I`: abstractions with few or no dependents | Interfaces written for consumers that never arrived |
| `volatile-interface` | A package's exported surface changes in a large share of its revisions | The interface is not shielding consumers from change |

`A` is a weak measure in code that is mostly functions or structurally typed, where little is declared abstract. In those codebases `D` is reported with that caveat, and the change-based findings (`against-stability`, `volatile-interface`, `zone-of-pain` by change frequency) carry the judgement.

### Boundary quality

| Finding | Signal | Reading |
|---|---|---|
| `deep-import` | Consumers importing a package's internals, past its entry point: deep import paths, private headers, `InternalsVisibleTo`, reflection on internal names. A package's own tests are excluded. | The boundary is not real. The declared interface is not the one in use. |
| `undeclared-dependency` | A package uses another that its manifest does not declare (resolved through hoisting or a transitive path) | The dependency graph the build sees is not the real one |
| `unused-dependency` | A declared dependency with no use in the package's code | Declared coupling with no purpose, and build weight |
| `purpose-mismatch` | The evidence contradicts the declared purpose: `reuse` with one consumer, `enforcement` with deep imports through it | The reason the package exists is not being served |

## The balance

For each package the skill reports where it sits between the three cohesion forces:

- **Closure** (CCP): its closure share, and the packages it changes with.
- **Reuse** (CRP): its reuse profile and export components.
- **Release** (REP): its consumers, deployables and version history.

and which force is under-served, at what cost. The reading depends on the package's situation:

- A package that changes often and is consumed by one or two others is paying for a boundary and getting nothing back. Closure matters most, and merging is the default candidate.
- A package that rarely changes and has many consumers has earned its boundary. Reuse matters most, and the question is whether consumers are carrying parts they do not need.
- A young package, inside the grace period, has had no time to be reused. Its findings are held as tentative.

The suite's defaults apply here as elsewhere. Evidence beats convention, so a package diagram is a hypothesis. Inlining is a first-class remedy, and at this level it is merging: **fewer packages is the default**, and a boundary has to justify itself by reuse, by a declared purpose, or by change evidence. Splitting needs evidence of disjoint reuse or independent change, never anticipation.

## Candidates

The CLI combines findings into candidates. Each is a proposal with its evidence, for the skill to judge.

| Candidate | From | Evidence that argues against |
|---|---|---|
| `merge` A into B | `always-together`, `single-consumer`, `lockstep`, `tiny`, `pass-through-package` | A declared purpose that still holds; different deployables; a merge that would create `disjoint-reuse` in the result |
| `split` | `disjoint-reuse`, `dumping-ground`, `inherited-weight` | The components co-change with each other, so they would become `always-together` |
| `move-unit` across a boundary | `crossing-unit`, `follower` | The move would create a package cycle, or the unit has consumers on both sides |
| `narrow-interface` | `overexposed`, `deep-import`, `volatile-interface` | Published package, where outside consumers cannot be seen |
| `fix-manifest` | `undeclared-dependency`, `unused-dependency` | None. These are corrections. |
| `break-dependency` | `package-cycle`, `against-stability`, `zone-of-pain` | Handed to the [structure](structure.md#skill) skill with its evidence pack |

Every merge candidate is checked for the split it might cause, and every split for the merge it might cause, so the tool cannot recommend a move that its own heuristics would then recommend reversing.

## CLI

Subcommands of the structure CLI. Every one supports `--json` with a versioned schema.

| Command | Output |
|---|---|
| `structure packages list` | Each package with its kind (internal, published), declared purpose, size, consumers, `Ca`, `Ce`, `I`, `A`, `D`, closure and change frequency |
| `structure packages cohesion [PACKAGE]` | The closure, reuse and release findings, and the balance for each package |
| `structure packages coupling` | Package cycles, dependencies against stability, and the zones |
| `structure packages boundaries [PACKAGE]` | Deep imports, undeclared and unused dependencies, and purpose mismatches |
| `structure packages candidates` | Ranked merge, split, move, narrow and fix candidates, each with the findings behind it and the evidence against |
| `structure packages evidence PACKAGE\|PAIR` | The full evidence for one package or one pair: co-change in both directions, shared changes, reuse profile, export components |
| `structure packages check` | Exits 1 on new package cycles, deep imports or undeclared dependencies against a base revision, as `structure check` does. For CI. |

Candidates are ranked by the change cost they address: the number of logical changes in the window that crossed the boundary in question, weighted by recency.

## Skill

Skill name `packaging`, in `plugins/structure/skills/packaging/`. It triggers on questions about package and module boundaries: "do we have too many packages", "should this be its own package", "where should this boundary be", "why does every change touch four packages", and on proposals to add a package.

Workflow:

1. Run `list` and `candidates`. Do not ask about every package: a large repository has too many.
2. For the packages in the leading candidates, confirm with the user whether each is published and what its purpose is, and record the answers in config. Evidence cannot supply a purpose, and a candidate cannot be judged without it. Then present the few candidates that address the most change cost, each with the principle it serves and the principle it costs.
3. For each candidate the user wants to pursue, run `evidence` and reason through it:
   - **Is the boundary earning anything?** Reuse, a declared purpose that the evidence supports, or independent change.
   - **What would the result look like?** A merge that produces a package with disjoint consumers trades a CCP problem for a CRP problem.
   - **Which force matters here?** By the package's change rate, consumer count and age.
   - **Is there a cheaper fix?** Moving one crossing unit, or narrowing an interface, often removes most of the cross-boundary change without repackaging anything.
4. Propose the smallest step. In order of preference: fix manifests, move a unit, narrow an interface, merge, split.
5. Apply in single-refactoring commits, with the build and tests green after each. A merge is one commit that moves the files and rewrites the imports together, since the build is broken between the two, then a second that removes the emptied package's manifest. Published packages are never changed.
6. Baseline the measures below before the first step.

When asked whether to **add** a package, the skill applies the same tests in advance: who the second consumer is, whether the code changes independently of its current home, and what purpose would be declared. Without an answer to one of them, the default is a folder, which costs nothing to promote later.

The skill uses the [red-flags](../../shared/red-flags.md) vocabulary at package level: a `pass-through-package` is a *shallow module*, a `follower` relation is *information leakage*, `overexposed` is *overexposure*, and layer-shaped packages that always change together are *temporal decomposition*'s structural cousin.

## Measurement

| Measure | What it shows | Role |
|---|---|---|
| Agent effort on tasks touching the reshaped packages | Navigation and build context got cheaper | Primary outcome |
| Packages touched per logical change, before and after, against comparable packages left alone | Changes land in fewer packages | Outcome, by construction for a merge |
| Closure of the reshaped packages | Changes stay inside the new boundaries | Outcome, by construction for a merge |
| Reuse profile and export components of merged packages | Merging did not create a dumping ground | Gaming check |
| Package count, and median distance `D` | Structure moved in the expected direction | Leading indicator only |

Merging two packages lowers packages-per-change and raises closure whatever else happens, so for a merge those two show only that the merge took place. Agent effort is the independent test ([suite.md](suite.md#measurement-across-the-suite)). For a split or a moved unit they are real outcomes, because nothing guarantees them. In the earlier window, the packages a reshaping replaced are counted as one unit, so before and after compare like with like.

Closure can be gamed by merging everything into one package, which has perfect closure. The gaming check is the opposing force: a merge that raises closure while the result's consumers use a falling share of it has traded one cost for another, and the skill reports it as such.

## Languages

Package discovery reads manifests, so it works in any language the suite has a manifest reader for, and the closure, co-change, lockstep and `wide-change` findings need only history. Reuse profiles, export components, abstractness, deep imports and manifest checks need the structural layer, and are `unavailable` without an adapter.

| Language | Package | Internals marker | Abstract types |
|---|---|---|---|
| TypeScript/JavaScript | Workspace package (`package.json`) | Anything outside `exports` or the entry point | Interfaces and abstract classes. Type aliases are not counted, since they would make any types-heavy package look fully abstract. |
| C# | Project (`.csproj`) | `internal`, with `InternalsVisibleTo` as the bypass | Interfaces, abstract classes |
| C++ | Build target | Headers outside the target's public include directory | Classes with pure virtual members |
| Python | Distribution (`pyproject.toml`) | Leading-underscore modules and names; anything outside `__all__`. Without an `__all__`, a module other than an `__init__.py` does not offer what it imports. | `Protocol` classes (interfaces) and `ABC` classes (abstract classes) |
| Java / Kotlin | Gradle or Maven module | Package-private and `internal`; non-exported packages in a module descriptor | Interfaces, abstract classes |
| Go | Module (`go.mod`) | Unexported (lower-case) identifiers, and packages under `internal/` | Interfaces |
| Rust | Crate | Anything not `pub` at the crate root | Traits |

## Configuration

In `structure.packages`:

- Package discovery overrides, and components to treat as packages where no manifests exist.
- Per package: `published`, declared `purpose`, and the deployables it ships in where that cannot be read from manifests.
- Thresholds: the comparable-share band for closure, significance and lift for `always-together`, the reuse share for `partial-use`, and the size percentile for `tiny`.
- The grace period for new packages (default 180 days).
- Names that prompt the `dumping-ground` check.

## Decisions

- **A skill in the structure plugin.** ADP and SDP are already structure's subject, and the package graph is its graph at a coarser level. The cohesion principles add evidence from locality and cochange. Package questions arise in a different situation from breaking one dependency, so they have their own skill.
- **Evidence for the principles, not the principles as rules.** Each principle becomes a measurement with a cost attached. A package that violates CRP at no observable cost is left alone.
- **Fewer packages by default.** This is the suite's inline-by-default principle at package level. Boundaries are kept for reuse, a declared purpose or independent change.
- **Declared purpose is an input.** Ownership, build time and enforcement are real reasons for a package that no repository evidence shows. Asking once and recording the answer is better than rediscovering the argument on every run.
- **Change evidence over the main sequence.** `A`, `I` and `D` describe the graph. A package in the zone of pain that never changes is not in pain. Change frequency decides.
- **Published packages are read-only.** Their consumers are invisible, so every reuse measure is an undercount.

## Open questions

- How to measure build cost, which is often the real reason for or against a package. It is not in git, and reading build-system caches or CI timings would be per-tool work.
- Whether `crossing-unit` moves between internal packages should use the locality mover, which currently refuses to cross package boundaries.
- How to treat packages that exist to enforce a layer rule the structure plugin could enforce with `structure layers` and no package at all.
- Whether abstractness is worth computing in languages where little is declared abstract, or whether the change-based findings should replace it there.

## Milestones

1. Package discovery from manifests, and `list` with closure, package co-change and the history-only findings.
2. Package-level cycles and stability, reusing structure's graph.
3. Reuse profiles and export components for TypeScript/JavaScript, with the CRP and REP findings.
4. Boundary quality: deep imports and manifest checks.
5. `candidates`, with the merge and split cross-checks.
6. Skill, declared-purpose capture and evals, including the case of a proposed new package.
7. Abstractness and distance from the main sequence.
8. Outcome measurement.
9. C#, then C++, then the tier-2 languages.
