# Structure Tool — Spec

Part of the code-health suite. Read [suite.md](suite.md) for shared conventions and [red-flags.md](../../shared/red-flags.md) for the design vocabulary. The plugin shares the `graph` package with [locality](locality.md) and reads co-change from the shared history cache.

## Purpose

The tool finds dependencies that make change expensive (cycles, layer violations, dependencies pointing towards volatile code) and gives the agent the evidence it needs to break them well. It tells the agent *which* dependency to break and *where*. It does not decide *how*.

Detecting a problem dependency is mechanical. Choosing a remedy is not. Depending on the case, the right move might be relocating a misplaced function, passing a callback, inverting a dependency through an interface, or introducing an event or mediator. The best choice depends on the codebase: which mechanisms it already uses, how its teams navigate it, and what the coupling is really about. Patterns emerge from a codebase rather than being imposed on it, so the tool describes the patterns already there and leaves the choice to judgement.

## Terms and guidelines

A **code smell** is Fowler's: a surface indication that usually corresponds to a deeper problem in the system. **Code health** is what the suite quantifies, as CodeScene uses the term: how easily code can be understood and changed, judged from several measures and never reduced to one score. A finding is a heuristic that says where to investigate. It does not prove a fault.

Numbers from CodeScene, from Tornhill's books and from the research cited here are **guidelines**. A guideline orders and annotates results and never hides them:

- Every command reports the measured value, the guideline and where the value sits (`aboveGuideline`, or a ratio such as `volatilityRatio`). Results are sorted by how far past the guideline they are.
- Commands do not drop a result for being under a guideline. Output is capped by `--limit` (default 20), and the output states how many rows the cap left out.
- A **minimum-evidence floor** is different: below it the statistic is not meaningful (one shared commit, too few revisions to call a side active, too few samples for a significance test). Items under a floor are reported as `insufficient-evidence` or with low confidence and are not given a verdict.
- Only commands that gate exit with 1: `check`, and the user's own configured layer rules inside it. Plain findings above a guideline never change the exit code.
- Guidelines are configurable. Each key below that is a guideline says so in its description in the config schema, with its source: CodeScene's documentation, Martin's or Tornhill's books, or a judgement call.

## Scope

In scope:

- Import cycles at file, folder and package level, with the smallest set of edges whose removal breaks each one.
- Layer and boundary violations against declared rules.
- Stability analysis: dependencies pointing from stable code towards volatile code, using both static structure and change history.
- A census of the decoupling mechanisms the codebase already uses.
- An evidence pack per problem dependency, for the agent's judgement.
- Measuring whether a break reduced coupling or only hid it.
- Package boundaries: whether the packages are the right ones, judged by the package cohesion and coupling principles. This is a second skill in this plugin, specified in [packaging.md](packaging.md).

Out of scope:

- Choosing a remedy mechanically, or generating pattern scaffolding.
- Introducing new infrastructure (an event bus, a DI container, a mediator) without the user's agreement.
- Cross-repository dependencies.

## Concepts

**Problem dependency.** An import edge, or a set of edges between two folders or components, that is part of a cycle, violates a layer rule, or points against stability. Hidden coupling counts as one too, though it has no import edge: the dependency exists and the graph does not show it.

**Breaking set.** For a cycle, the minimum set of symbol-level edges whose removal makes the folder or file graph acyclic: a minimum feedback arc set. That is NP-hard in general, but cycles in import graphs are small after folder grouping. Small components are solved exactly, and larger ones use the Eades–Lin–Smyth heuristic with deterministic tie-breaks (lower co-change first, then path order). Many cycles come down to one or two symbols used in the "wrong" direction.

**Stability.** Martin's instability, `I = Ce / (Ca + Ce)` (outgoing over total dependencies), is *structural* stability. *Change* stability is revisions per file in the window, from the history cache. When the two disagree, change stability is used, because it shows what actually changes. The stable dependencies principle says dependencies should point towards more stable code. A dependency from a stable module onto a volatile one forces the stable one to change with it.

**Stability listing.** A module is active at `minRevisions` (an evidence floor of 3). When the depended-on side is active, change stability decides: its revisions per file are compared with the dependant's, and the ratio is `volatilityRatio`. A dependant with no revisions has no ratio (null), and a dependency from it onto an active module is above the guideline. When the depended-on side is not active, structure decides, from the instability gap in percentage points. `stability` lists every dependency onto a less stable side. `aboveGuideline` is set when the ratio reaches `minVolatilityRatio` (guideline 2) or the gap reaches `minInstabilityGap` (guideline 20 points). Both comparisons use "reaches", meaning greater than or equal to. Rows above the guideline come first, then rows decided by change, then the larger margin, then the number of file imports behind the edge. Ca and Ce count distinct files outside the module. `extra.units` lists the fifty most volatile modules and `unitsTotal` is the full count. The 2 and the 20 are judgement calls. CodeScene has no stability rule.

**Static coupling.** For a pair of modules, the count of distinct symbols referenced across the boundary, weighted by reference sites. It measures how much one side's code uses the other.

**Coupling quadrants.** Static coupling and co-change measure different things. Together they say what a dependency is costing:

| | Low co-change | High co-change |
|---|---|---|
| **High static coupling**, both sides active | **Incidental**: the code is entangled but the changes are independent. A candidate for breaking: cheap and low-risk, since no shared decision is being split. | **Real**: the sides share a design decision. Co-locate them (locality) or put the decision in one place. Do not hide it behind indirection. |
| **High static coupling**, depended-on side rarely changes | **Stable dependency**: healthy. Keep it. | (Cannot occur: a side that rarely changes cannot co-change often.) |
| **Low static coupling** | **Independent**: nothing to do. | **Hidden**: see below. Make the dependency explicit, or co-locate. |

"Both sides active" means each side has at least the configured minimum revisions in the window (an evidence floor), so low co-change is evidence and not just an absence of data. Co-change is judged against what independence would predict, `E = n(A)·n(B)/N` shared changes over *N* logical changes, using cochange's eligible-change counts. Comparing the observed count with *E* directly is not enough. On real histories *E* is usually well below one, so a single shared change would exceed it and almost every pair would look coupled. Instead:

- **High co-change**: support clears the minimum, and the observed count is significantly above *E* (a one-sided exact test at the configured level, default 0.01).
- **Low co-change**: both sides are active, and the observed count is not significantly above *E*.
- **Insufficient evidence**: too little activity to tell. The pair is reported as such and placed in no quadrant.

Incidental means low co-change despite high static coupling.

**Placement.** "High static coupling" means the reference sites across the boundary, both directions summed, reach `minStaticCoupling` (a guideline of 3, a judgement call). The quadrant is a classification for reading the pair. The measured sites, shared changes, expected shared changes and the p-value are always reported beside it, so a reader can see how close to the guideline a pair sits. The rules, in order:

- High static coupling, with the depended-on side inactive: **stable**. With the dependant inactive: `insufficient-evidence`. Otherwise high co-change gives **real** and low co-change gives **incidental**.
- Low static coupling (fewer sites than the guideline, which includes some pairs that do import each other): high co-change gives **hidden**, both sides active gives **independent**, anything else `insufficient-evidence`.

`from` is the side that uses the other more, and on a tie the earlier path. The p-value is reported to six decimal places, so `0` means the exact value is below that, which is very strong evidence. Support (shared changes of at least `minSupport`, default 3) is an evidence floor. Cochange's own `minSupport` default is 5, a stricter figure chosen for ranking whole-repository pairs. Each plugin states its own value, so a pair can be high co-change in one and not the other. The test here is the stronger one: it compares against what independence predicts, where CodeScene (after Tornhill's code-maat) uses a minimum number of shared revisions and a minimum degree.

Incidental coupling is cheap to break but does not cost change effort directly, so on its own it ranks low. It ranks high when it also blocks a locality move, forms part of a cycle, violates a layer rule, or burdens agents with reads (files opened only to follow the dependency, from transcripts). The agent-reads reason applies when at least `minAgentTasks` tasks (default 3, an evidence floor, separate from `minSupport`) edited one side and opened a file of the other only to follow the dependency. The measured count is always reported.

**Registration hub.** A central file that every feature has to edit: route tables, menu definitions, reducer or handler maps, DI module lists, feature-flag lists. It is a one-to-many shape, described deterministically by four signals:

- **Star co-change.** The hub co-changes with many distinct folders or components, at high confidence feature→hub, while those features rarely co-change with each other (each pair has low co-change, as defined under the quadrants).
- **Outward dependencies.** The hub imports the features, or holds their identifiers (component references, path strings), so the stable mechanism depends on the volatile features.
- **Append-shaped edits.** Most of the hub's diff hunks add or remove entries in one collection literal (array, object, switch). The lexical layer detects it in any language: hunks that are pure additions or removals of a few lines at a constant indentation, inside the same block, and lexically similar to their neighbours. Where a structural adapter exists, hunks are mapped onto the syntax tree to confirm the collection literal.
- **Contention.** Many distinct authors edit it within short windows, a proxy for merge conflicts. Only the count is used, never names.

The signals are guidelines (`hubMinFeatures` 3, `hubMinConfidence` 50, `hubMaxFeatureCoupling` 20, `hubMinOutward` 50, `hubMinAppendShare` 60, `hubContentionDays` 14, `hubMinAuthors` 3). They are judgement calls, close in spirit to CodeScene's co-change hotspots that are prioritised by how many developers touch them. A hub row reports each signal with the figures behind it and whether the signal reached its guideline (`reached`), and `signalsReached` counts them. A file is listed when at least two signals reached their guidelines, because each alone matches ordinary files (a busy file, a barrel of imports) and two together are worth a look. This is the one pre-filter in `structure hubs`, and it exists for cost. The fourth signal is read from `git log -p` for the file, one git process per file, so a file that reaches none of the three signals that need no diff (star co-change, outward dependencies, contention) is omitted without reading its diff, because it could reach one signal at most. Measured on this repository (481 logical changes in the window), reading the diff of every file with at least `minRevisions` changes took 164 reads and 3.4 s, against 8 reads and 1.5 s with the pre-filter, and the cost grows with the file count and history length. The command therefore keeps the pre-filter and counts what it leaves out: JSON carries `omitted` (`minSignals`, `considered`, `files`, `withoutDiffs`, `belowMinRevisions`) and the table prints a notice giving the same counts. `considered` is the files with at least `minRevisions` eligible changes, `files` is those that reached fewer than two signals, `withoutDiffs` is the part of `files` whose diffs were not read (their append share is not known), and `belowMinRevisions` is the files with too little history, an evidence floor, which are not in `considered`. Rows sort by the number of signals reached, so files reaching all four come first, then by the figures behind each signal: the number of features, the share of features the hub references, the append share, the most authors within the contention window, and then the revision count and path. The append shape is detected lexically: runs of `git -U2` hunks of at most five lines whose Dice similarity to their neighbours is at least 0.7. Structural confirmation that the lines belong to one collection literal is not done in any language, so a hub's append share is an estimate and false positives are possible.

The hub breaks the stable dependencies principle: it is volatile only because it depends on everything that changes. In Ousterhout's terms it is *information leakage*. Each feature's placement in the app is that feature's decision, but it is written down in the hub.

**Hidden coupling.** Co-change between two modules with no static dependency between them. A dependency "broken" through indirection such as events, a mediator or string-keyed registries often becomes hidden coupling: the imports go away and the co-change remains.

**Mechanism census.** An inventory of how the codebase already decouples things, found by tree-sitter queries in the language adapter:

| Mechanism | Detection |
|---|---|
| Parameters and callbacks | Functions taking function-typed parameters across folder boundaries |
| Interfaces with implementations elsewhere | Interface or abstract type in one folder, implemented in another |
| Dependency injection | DI decorators, container registration calls, constructor injection of interface types |
| Events and pub-sub | `emit`/`on`/`subscribe`/`publish`/`dispatch` calls, event-emitter base types |
| Mediator, command or query handlers | Handler registration and dispatch by type or key |
| Registries and plugins | Maps from string keys to implementations, `register*` calls |
| Ports and adapters folders | Folder naming (`ports/`, `adapters/`, `infrastructure/`), configurable |

The census reports counts, folders where each mechanism appears, and a few example locations. It describes; it does not judge which mechanism is good.

**Rows.** Every mechanism has a row, in the fixed order above, with a count of 0 when none was found. A zero row is how the skill knows a mechanism is not in use, so would be new. The output shape does not depend on the repository.

**What is counted.** The detectors are heuristics, in the way CodeScene's smell detectors are, and a count is a lower bound: zero means none found by these rules.

- *Callbacks*: a function with a function-typed parameter that is called from a file in another folder.
- *Interfaces*: an interface or abstract type that is implemented or subclassed in another folder. The declaration is found through the import graph, including barrels. A match that is ambiguous is skipped and not guessed.
- *Dependency injection*: a DI decorator from a fixed list, a registration call on a receiver named like `container`, `injector`, `kernel` or `ioc`, or a constructor parameter whose type resolves to an interface declared in another folder. Property and method injection are not counted.
- *Events*: calls such as `emit`, `on`, `subscribe`, `publish` and `dispatch`, and event-emitter base types. Calls on platform receivers (the DOM and the like) are excluded, and `addEventListener` is excluded on purpose.
- *Handlers*: handler decorators, and registration or dispatch on a mediator or command bus. A call that matches handlers is not also counted as an event.
- *Registries*: `register*` calls, and maps from string keys to implementations, as a `Map` or an object.
- *Ports and adapters*: folders named `ports`, `adapters` or `infrastructure`, plus any in `structure.census.folderNames`. Detection is by folder name only.

These lists are product behaviour and are documented in the mechanisms reference. A convention with other names is taught to the census through `structure.census`. Every list there (`folderNames`, `eventCalls`, `handlerCalls`, `registerCalls`) adds to the built-in vocabulary, and none replaces it. Call names match on any receiver.

**Untyped code.** Detection is per language. Plain JavaScript is read for what needs no type annotation (events, handlers, registries, folders). Callbacks, constructor injection and implementations need declared types, so in untyped code those rows undercount, and a zero there is weaker evidence than a zero in typed code. The skill reads the examples before relying on a zero.

**Nearby mechanisms.** `nearbyMechanisms` lists the ten census entries nearest to the two sides of a dependency (an explicit limit, a judgement call). Distance is the number of steps through the folder tree, up to the common ancestor and down, from the nearest of the entry's folders to the nearest folder of either side. The same folder distance is the locality measure. Entries are ordered by distance, mechanism order, path and line, and each says which side it is `near`. `nearbyMechanismsOmitted` is the number of entries the limit left out. An empty list with nothing omitted means the census is empty.

**Command contract.** `structure census` reads no history. It has no refresh, window or evidence grade, because nothing in it comes from history, and it works in a shallow clone. It extends the plain envelope and writes a report like other commands.

## Graph details

**Cycle levels.** A file-level cycle is a cycle of file imports. The **default level** is chosen per file by its language: a Go file is a node of its Go package (its directory), a C# file is a node of its folder, and a file of any other language is a node of itself. `cycles` and `check` use it when `--level` is not given, and name it `default` in `level`. Files of one Go package reference each other without imports and Go forbids cycles only between packages, so at file level an edge between two Go files in one directory is left out and is never a cycle, and Go has no file cycles. C# files in one project reference each other without imports, so C# is judged by folder by default, and its file cycles are listed only with `--level file`. A folder is the directory directly containing a file, so a parent folder and its child folder that import each other form a folder cycle. A folder cycle whose folders all lie on one path from the root (each is an ancestor or descendant of the others) has `nested: true`. It is listed, and sorts after every cycle with `nested: false`, because such a cycle is often a folder and its own sub-folders and not a dependency between separate parts. Every other cycle has `nested: false`. Cycle rows sort by nested last, then locality gain, size, co-change, id. A package is what `structure packages` discovers from manifests (see [packaging.md](packaging.md#concepts)). The package index is built once when the project is loaded, from that discovery, and `cycles --level package` uses it, so both commands put each file in the same package. Configured components stand in where no manifest is found, and a file that no package owns is placed in the package `.`. A component drops files that are in no component. Edges inside one group are dropped. A self-loop is a cycle and is always in its breaking set.

**What enters the graph.** Tests, `exclude` globs and generated files are left out. Type-only imports are edges flagged `typeOnly`, because they bind code at design time, and a reader can discount them. Changes over `maxChangesetSize` files are not counted in activity, as CodeScene ignores very large changesets in coupling. This also covers an import-everything first commit, which is why the initial commit has no special rule.

**Breaking sets.** A component of at most `exactLimit` nodes (default 16, at most 30) gets a minimum set. A larger one gets the heuristic set, pruned to an inclusion-minimal set. Each cycle row states `method` as `exact` or `heuristic`, so a reader can see which advice is a minimum. Ties go to lower co-change, then path order. A **dominator unit** is an entry file's whole cycle plus everything only reachable through it. Files unreachable from the entry are returned separately.

**Language details.** Where a language has no exports map, entry files are the files nothing else imports, plus the language's own marker. A C# project exports its public types. A C++ target exports its `PUBLIC` and `INTERFACE` headers, else every owned header, so nothing is internal. A Go package has no declared entries, and `internal/` marks what is private. C++ treats a header and its paired source file as one unit with an edge from header to source, so pairs are not reported as include cycles, and dependencies only the source has are not visible to header users. C# treats the parts of a partial class as one unit, resolves names within a project and its transitive references, and treats `Box` and `Box<T>` as one declaration. Members are not symbols there, so instance method calls are not resolved, and locality and structure undercount method-level coupling. In Java a single-type import aliases that type only, and wildcard imports add a package scope. In Rust a `mod name;` is an import edge, so a parent and child that use each other form a cycle that is idiomatic in Rust and worth a look and not a fault. `use a::Enum::Variant` imports the first capitalised segment, which misreads lowercase type names. Python entry files are the non-test modules with no leading-underscore path segment. `__all__` governs what a module offers, and a module other than a package `__init__` does not offer what it imports. These are per-language approximations, pinned by the adapters' conformance fixtures.

**Abstract types.** Interface, abstract class and class are mapped per language for abstractness and the census. A Python `Protocol` is an interface and an `ABC` an abstract class. A Rust trait is an interface, including one with default methods, and a struct or union is a class. In C++ an interface is a class with only pure virtual members and no data, and an abstract class has any pure virtual member. Events and callbacks follow each language's own form: C# events are `E?.Invoke(...)` or `E(...)` on an event the file declares and C# callbacks are not detected, and C++ counts `std::function`, function-pointer parameters and `emit`.

## Locality report contract

`structure` reads the output of `locality analyse` only when its tool, command, head commit and clean flag match the analysed commit. It uses rows with a `path` or `id` and blockers with `from`, `path` and `unblockedGain`. The report carries `schemaVersion`, and `structure` ignores a report whose version is not 1 ([locality.md](locality.md#report-contract)). `misplacement` is computed in `structure` and not from a locality score: a move may remove a dependency when a strict majority of the consumer sites sit on the `from` side.

## Evidence pack

For each problem dependency the CLI emits:

| Field | Meaning |
|---|---|
| `kind` | `cycle`, `layer-violation`, `unstable-dependency`, `incidental-coupling`, `hidden-coupling` or `registration-hub` |
| `quadrant` | Incidental, real, stable, hidden or independent, or `insufficient-evidence`, with the static-coupling, co-change and expected-co-change figures behind it |
| `from` / `to` | Modules (file, folder or component) and the edge direction |
| `breakingSet` | The specific symbols used across the boundary that cause the problem |
| `stability` | Structural and change stability of each side |
| `stabilityVerdict` | Whether the dependency points towards less stable code, whether the margin is above the guideline, and the measured ratio or gap |
| `coChange` | Co-change between the sides, in both directions |
| `misplacement` | Whether a breaking-set symbol's consumers mostly sit on the other side, from a locality score. If so, the dependency may disappear by moving the symbol. |
| `unblocks` | Locality moves this dependency is blocking, with their unblocked gain, read from the locality report when present |
| `nearbyMechanisms` | Up to ten census entries in or next to the two modules, nearest first, with `nearbyMechanismsOmitted` giving how many were left out |
| `layerRule` | The rule broken, if any |

A stability row below the guideline is still listed by `stability`, but its evidence pack gets no problem kind for it: `unstable-dependency` appears in `kinds` only when `stabilityVerdict.aboveGuideline` is true. The pack still carries `stabilityVerdict` with the measured ratio or gap, so a reader can see how far below the guideline it sits.

The pack carries no recommended technique. It carries facts that bear on the choice.

## Skill

The skill reasons from the evidence pack to a remedy, and states its reasoning. It is guided by questions, not a decision table:

1. **Is the dependency real?** Dead imports, and types imported only for convenience, are removed. If `misplacement` shows the symbol belongs on the other side, moving it (a locality move) is usually the whole fix, and it adds no machinery.
2. **What is the coupling about?** Read the breaking-set symbols and the co-change. High co-change means the two sides share a design decision, so the coupling is real. Hiding it behind indirection keeps the cost and loses navigability. The fix is to put the decision in one place (*information leakage*), or to accept the dependency and fix its direction. Low co-change, with both sides active, means the dependency is incidental and can be cut cheaply. Low co-change because the depended-on side never changes means a stable dependency, which is left alone. The `quadrant` field says which.
3. **Which way should it point?** Towards the more stable side, by change evidence.
4. **How does this codebase already do it?** Prefer the mechanism already used nearby, from `nearbyMechanisms`. Consistency with local patterns is worth more than the textbook choice. When several are used, prefer the one used closest to the boundary.
5. **What is the least machinery that works?** Simpler options come first in consideration (moving, passing a value or callback, an interface owned by the stable side, then indirection through events, mediators or registries). The list is an order for *considering* options, not a rule. Indirection removes a static dependency at the price of discoverability, which costs agents most, since they navigate by references.
6. **Does it introduce something new?** If the chosen mechanism is not in the census, the skill stops and asks the user, with the alternatives it weighed. New infrastructure is a team decision.

The skill records the remedy, the alternatives considered and the evidence in the commit message, using red-flag names where they apply. Each break follows suite commit discipline: a move, or a dependency inversion, is its own commit with tests green.

### Registration hubs

The remedy family is **inverting the registration**. Each feature owns its contribution (its route, menu entry, handler), and the hub only collects. How it collects is the judgement call, informed by the census and the framework:

- **Convention-based discovery** the framework already supports (file-system routing, build-time globbing, codegen). This is often the least code, because the framework supplies the mechanism.
- **Feature-owned declarative contributions**: each feature exports a contribution object, and one aggregation point lists the features or discovers them. The aggregation list can remain, shrunk to one line per feature that never needs editing again for changes within a feature.
- **Container multi-binding or a plugin registry**, when the codebase already uses one.

What the skill weighs:

- **Prefer declarative over side-effect registration.** Registration triggered by importing a module depends on import order, defeats tree-shaking, and hides what is registered. An explicit contribution that is collected is easier for agents and people to trace.
- **Keep the overview.** A central route or menu file is also documentation: one place to see the whole app. If the inversion removes it, the skill keeps a generated or queryable view (a script, a test that snapshots the assembled table) so the overview survives.
- **Ordering and cross-cutting rules.** Menu order, permissions and grouping often lived in the hub. They move into explicit fields on each contribution (order, group), or stay central as policy over contributions. They must not become implicit in discovery order.
- **The census decides the mechanism.** If no similar mechanism exists in the codebase, the skill asks before introducing one, as for any new mechanism.

Success is measured as for any break: feature changes stop touching the hub, the change spread of feature work drops, and the hub's revision count and contention fall.

The skill does not default to any named pattern. Patterns such as mediator, observer and ports-and-adapters are in the references as background vocabulary, each with when it fits and what it costs, and each is chosen only when the evidence and the census support it.

## CLI

| Command | Output |
|---|---|
| `structure cycles [--level default\|file\|folder\|package]` | Cycles with their breaking sets, ranked by locality gain unblocked (when a locality report is present), then size of the cycle and co-change across it |
| `structure layers` | Imports the configured layer rules do not allow, value imports first and then type-only imports |
| `structure stability [--by folder\|component]` | Structural and change stability, and every dependency pointing towards less stable code, with those above the guideline listed first |
| `structure census` | Decoupling mechanisms in use, with counts and examples |
| `structure hubs` | Registration hubs that reach at least two of the four signals, sorted by signals reached and then the figures behind them, with which signals reached their guidelines and the collection literal being appended to. It reports how many files it omitted for reaching fewer than two (`omitted`, and a notice under the table) |
| `structure evidence EDGE\|FINDING` | The full evidence pack for one problem dependency |
| `structure coupling [--quadrant incidental\|real\|stable\|hidden] [--by file\|folder\|component]` | Module pairs placed in the coupling quadrants, ranked within each |
| `structure hidden` | Pairs with high co-change and no static dependency, the result of earlier indirection. Shorthand for `coupling --quadrant hidden`. |
| `structure check [--base REV]` | Exits 1 on cycles or layer violations that are new since a base revision (default: the merge base with the configured main branch). For CI. It is the one gating command, as CodeScene's pull request gate fails only on regressions against the base. Existing debt does not fail it. |
| `structure outcome FROM->TO --at REV` | Whether the break made at `REV` reduced the coupling of a pair or only hid it: co-change over matching windows before and after, static coupling before and after, and a verdict (`broken`, `hidden-not-broken`, `unchanged`, `co-change-reduced`, `no-baseline`, `insufficient-evidence`). It also lists every other pair that dropped its static dependency across the break and kept its co-change. |
| `structure packages …` | Package inventory, cohesion, coupling, boundaries and repackaging candidates. See [packaging.md](packaging.md#cli). |

## Measurement

A break succeeded only if it made change cheaper, not merely if the import went away.

| Measure | What it shows | Role |
|---|---|---|
| Co-change between the two sides, before and after over matching windows | The coupling actually reduced | Primary outcome |
| Hidden coupling created: pairs that dropped their static edge but kept their co-change | The dependency was hidden, not broken | Gaming check |
| Agent effort on tasks that touch either side | Navigation did not get worse through indirection | Agent outcome |
| Cycle count and layer violations | Structure is cleaner | Leading indicator only |

A broken cycle with unchanged co-change is reported as **hidden, not broken**. The skill presents that as evidence the remedy treated the symptom.

**Outcome verdicts.** Both windows are the shorter of `windowMonths` and the time from the break to the analysed commit, with the break's own change left out of both. Static coupling is measured at the break's parent and at the tip. The verdicts are `no-baseline` (the pair had no earlier history), `hidden-not-broken` (the static edge went and the co-change stayed), `unchanged`, `insufficient-evidence`, `broken` and `co-change-reduced`. They describe what the numbers show and do not claim the break caused them. The agent-effort outcome from the table above is measured only for repackaging (see [packaging.md](packaging.md#measurement)), and is not measured for a single break. This follows CodeScene's practice of presenting trends and deltas with a time window and not as proof.

## Configuration

In the `structure` section of the suite config:

- Layer rules (`layers`): ordered layers, each with a `name`, `paths` globs and an optional `allow` list. A file belongs to the first layer matching it and files in none are unconstrained. By default a layer may depend on itself and the layers listed after it, and `allow` replaces that with exactly the layers named. Layer rules are the user's own declaration, so they are rules and not guidelines, and `check` gates on them. A type-only import that crosses a disallowed layer is listed, marked `typeOnly` and ranked after value imports. `check` counts it, because a type dependency still binds the layers. CodeScene does not check layer rules, and this follows dependency-cruiser and ArchUnit, which count type imports too.
- Component boundaries, shared with the suite-wide `components`.
- Additional census patterns (custom event, handler, registration and folder names). Every list adds to the built-in vocabulary.
- Guidelines and evidence floors. Guidelines: `minStaticCoupling` (reference sites both ways), `minVolatilityRatio`, `minInstabilityGap`, and for registration hubs (`hubMinFeatures`, `hubMinConfidence`, `hubMaxFeatureCoupling`, `hubMinOutward`, `hubMinAppendShare`, `hubContentionDays`, `hubMinAuthors`. Evidence floors: `minSupport`, `minAgentTasks` (tasks needed for the agent-reads reason on incidental pairs), `significanceLevel` and `minRevisions` for "active". Hidden coupling is the low-static-coupling, high-co-change quadrant and uses the same values.
- Base revision for `check`: `base`, or the merge base with `mainBranch`. `check` counts a cycle as new unless all its nodes sat in one cycle of the base, and a layer violation as new unless the same import violated at the base. It checks the default, folder and package levels unless `--level` narrows it, and lists a cycle once when its nodes are the same at two levels (a Go package is also a folder and a package). When the base is the analysed commit, the result is empty. With no `base` and no `mainBranch` or `origin/mainBranch` to find a merge base, `check` exits with a usage error asking for `--base`, because a silent default would pass a check that compared nothing. The comparison to a base and the report of regressions only match CodeScene's delta analysis.
- Shared history settings, read from the top-level `history` section of the suite config ([suite.md](suite.md#configuration)) and overridable here under the same names: `windowMonths`, `maxChangesetSize`, `botPatterns`, `branch`, `firstParent`, `renameSimilarity`, `renameLimit` and `evidence`. A value set under `history` applies to structure and cochange alike. A value set in only one plugin's section applies to that plugin, and the two can then disagree for one repository, so state both when they should match. `exactLimit` is structure's own.
- Package settings under `structure.packages` ([packaging.md](packaging.md#configuration)).

## Decisions

- **Evidence, not prescriptions.** Remedy choice depends on context the tool cannot see. Making it deterministic would mean making it wrong by default.
- **A stated departure from suite principle 6.** The suite forbids plugins from creating shared helpers or abstractions. Breaking a dependency sometimes needs one: an interface owned by the stable side, or a contribution type. The skill may introduce one only as the remedy for a specific problem dependency, only after moving the symbol and passing a value or callback have been ruled out, preferring a mechanism the census already shows, and asking first for anything new.
- **Follow the codebase.** The census makes existing patterns visible, so the agent stays consistent with them. Anything new needs agreement.
- **Change evidence outranks structure.** Instability metrics describe the graph. Co-change describes the cost.
- **Measure hidden coupling.** It is the failure mode most specific to dependency breaking. Without it, indirection looks like success.

## Open questions

- How far census detection can go without per-framework adapters, for example for DI in different frameworks.
- Whether to support layer rules inferred from the current structure (`structure layers --infer`) as a starting point for teams with no declared rules.
- Whether `structure` and `locality` should merge. They share the graph, and many cycles are fixed by a locality move. They answer different questions and trigger at different times, so the default is separate plugins.

## Milestones

1. File and folder cycles with exact and heuristic breaking sets.
2. Stability from structure and history, and the evidence pack. Its `quadrant` field arrives with milestone 6.
3. Mechanism census for TypeScript/JavaScript, then C# (DI containers, MediatR-style handlers, events) and C++ (virtual interfaces, callbacks, signal/slot libraries).
4. Skill reasoning guide and references, with evals that check it asks before introducing a new mechanism and does not default to a named pattern.
5. Layer rules and `check`.
6. Coupling quadrants, hidden-coupling detection and outcome measurement.
7. Registration hub detection (star co-change, append-shaped edits) and the inversion guidance.
8. Packaging skill, following its own milestones.
