# Structure Tool — Spec

Part of the code-health suite. Read [suite.md](suite.md) for shared conventions and [red-flags.md](../../shared/red-flags.md) for the design vocabulary. The plugin shares the `graph` package with [locality](locality.md) and reads co-change from the shared history cache.

## Purpose

The tool finds dependencies that make change expensive (cycles, layer violations, dependencies pointing towards volatile code) and gives the agent the evidence it needs to break them well. It tells the agent *which* dependency to break and *where*. It does not decide *how*.

Detecting a problem dependency is mechanical. Choosing a remedy is not. Depending on the case, the right move might be relocating a misplaced function, passing a callback, inverting a dependency through an interface, or introducing an event or mediator. The best choice depends on the codebase: which mechanisms it already uses, how its teams navigate it, and what the coupling is really about. Patterns emerge from a codebase rather than being imposed on it, so the tool describes the patterns already there and leaves the choice to judgement.

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

**Static coupling.** For a pair of modules, the count of distinct symbols referenced across the boundary, weighted by reference sites. It measures how much one side's code uses the other.

**Coupling quadrants.** Static coupling and co-change measure different things. Together they say what a dependency is costing:

| | Low co-change | High co-change |
|---|---|---|
| **High static coupling**, both sides active | **Incidental**: the code is entangled but the changes are independent. A candidate for breaking: cheap and low-risk, since no shared decision is being split. | **Real**: the sides share a design decision. Co-locate them (locality) or put the decision in one place. Do not hide it behind indirection. |
| **High static coupling**, depended-on side rarely changes | **Stable dependency**: healthy. Keep it. | (Cannot occur: a side that rarely changes cannot co-change often.) |
| **Low static coupling** | **Independent**: nothing to do. | **Hidden**: see below. Make the dependency explicit, or co-locate. |

"Both sides active" means each side has at least the configured minimum revisions in the window, so low co-change is evidence and not just an absence of data. Co-change is judged against what independence would predict, `E = n(A)·n(B)/N` shared changes over *N* logical changes, using cochange's eligible-change counts. Comparing the observed count with *E* directly is not enough. On real histories *E* is usually well below one, so a single shared change would exceed it and almost every pair would look coupled. Instead:

- **High co-change**: support clears the minimum, and the observed count is significantly above *E* (a one-sided exact test at the configured level, default 0.01).
- **Low co-change**: both sides are active, and the observed count is not significantly above *E*.
- **Insufficient evidence**: too little activity to tell. The pair is reported as such and placed in no quadrant.

Incidental means low co-change despite high static coupling.

Incidental coupling is cheap to break but does not cost change effort directly, so on its own it ranks low. It ranks high when it also blocks a locality move, forms part of a cycle, violates a layer rule, or burdens agents with reads (files opened only to follow the dependency, from transcripts).

**Registration hub.** A central file that every feature has to edit: route tables, menu definitions, reducer or handler maps, DI module lists, feature-flag lists. It is a one-to-many shape, detected deterministically from four signals together:

- **Star co-change.** The hub co-changes with many distinct folders or components, at high confidence feature→hub, while those features rarely co-change with each other (each pair has low co-change, as defined under the quadrants).
- **Outward dependencies.** The hub imports the features, or holds their identifiers (component references, path strings), so the stable mechanism depends on the volatile features.
- **Append-shaped edits.** Most of the hub's diff hunks add or remove entries in one collection literal (array, object, switch). The lexical layer detects it in any language: hunks that are pure additions or removals of a few lines at a constant indentation, inside the same block, and lexically similar to their neighbours. Where a structural adapter exists, hunks are mapped onto the syntax tree to confirm the collection literal.
- **Contention.** Many distinct authors edit it within short windows, a proxy for merge conflicts. Only the count is used, never names.

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

## Evidence pack

For each problem dependency the CLI emits:

| Field | Meaning |
|---|---|
| `kind` | `cycle`, `layer-violation`, `unstable-dependency`, `incidental-coupling`, `hidden-coupling` or `registration-hub` |
| `quadrant` | Incidental, real, stable, hidden or independent, or `insufficient-evidence`, with the static-coupling, co-change and expected-co-change figures behind it |
| `from` / `to` | Modules (file, folder or component) and the edge direction |
| `breakingSet` | The specific symbols used across the boundary that cause the problem |
| `stability` | Structural and change stability of each side |
| `coChange` | Co-change between the sides, in both directions |
| `misplacement` | Whether a breaking-set symbol's consumers mostly sit on the other side, from a locality score. If so, the dependency may disappear by moving the symbol. |
| `unblocks` | Locality moves this dependency is blocking, with their unblocked gain, read from the locality report when present |
| `nearbyMechanisms` | Census entries in or next to the two modules, nearest first |
| `layerRule` | The rule violated, if any |

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
| `structure cycles [--level file\|folder\|package]` | Cycles with their breaking sets, ranked by locality gain unblocked (when a locality report is present), then size of the cycle and co-change across it |
| `structure layers` | Violations of the configured layer rules |
| `structure stability [--by folder\|component]` | Structural and change stability, and dependencies pointing against stability |
| `structure census` | Decoupling mechanisms in use, with counts and examples |
| `structure hubs` | Registration hubs, ranked by the number of features feeding them and their revision count, with the signals that fired and the collection literal being appended to |
| `structure evidence EDGE\|FINDING` | The full evidence pack for one problem dependency |
| `structure coupling [--quadrant incidental\|real\|stable\|hidden] [--by file\|folder\|component]` | Module pairs placed in the coupling quadrants, ranked within each |
| `structure hidden` | Pairs with high co-change and no static dependency, the result of earlier indirection. Shorthand for `coupling --quadrant hidden`. |
| `structure check [--base REV]` | Exits 1 on cycles or layer violations that are new since a base revision (default: the merge base with the configured main branch). For CI. |
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

## Configuration

In the `structure` section of the suite config:

- Layer rules: ordered layers as globs, and allowed directions.
- Component boundaries, shared with the suite-wide `components`.
- Additional census patterns (custom event or handler conventions).
- Thresholds for static coupling, minimum support and the significance level for high co-change, minimum revisions for "active", and hidden coupling.
- Base revision for `check`.
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
