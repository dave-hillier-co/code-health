# Locality Refactoring Tool — Spec

Part of the code-health suite. Read [suite.md](suite.md) for packaging, the CLI contract, config, caches and testing, and [red-flags.md](red-flags.md) for the design vocabulary the skill uses.

## Purpose

The tool finds code that lives far from the code that uses it, moves it into a cohesive home or inlines it, and proves that changes became cheaper as a result. Success is a measurable improvement in the ability to change the code, not a better static score.

Distant code costs every reader a hop. A human with an IDE pays little; an agent pays in files opened, tokens read and chances to miss something. Distance mostly arrives through folder conventions (`utils/`, `helpers/`) and anticipated reuse that never happened. The tool tests that reuse claim against the evidence and removes the distance where the evidence is missing.

Code that is widely used has earned its distance. It has also earned scrutiny, because every flaw in it is multiplied by its consumers. So the tool reviews it rather than moving it.

## Philosophy

### Locality is cohesion, made measurable

Cohesion is the goal: things that belong together live together. Locality is how the tool measures it, as folder-tree distance between code and its consumers, and as consumer overlap within a module. Coupling is the other side. Code far from its consumers creates coupling across the tree that cohesion would have kept inside one folder.

The classic cohesion levels (Constantine and Yourdon) name what the tool finds:

| Cohesion level | What it looks like | What the tool does |
|---|---|---|
| **Coincidental** | `utils/`, `helpers/`, `common/`: grouped by nothing | Units move to their consumers; mixed files are split |
| **Logical** | Grouped by kind: `controllers/`, `models/`, `services/`, `types/` | Distance across kind-folders is reported; framework fixed points limit moves |
| **Temporal** | Grouped by when it runs: `init/`, `startup/`, `parse` → `validate` → `save` | Flagged through co-change, matching Ousterhout's *temporal decomposition* |
| **Functional** | Grouped by the one thing it does, with its consumers nearby | The target |

Two kinds of evidence count. *Usage* cohesion is consumers in the same place. *Change* cohesion is code that changes together, from co-change. When they disagree, change evidence wins, because the cost the suite measures is the cost of change.

### The case for inlining

Inlining is a positive design choice, not only a cleanup. John Carmack's argument for inlined code (his 2007 email, republished in 2014) and Jonathan Blow's similar position in his talks on programming practice come down to a few points:

- **Visible state and order.** Code read straight down shows exactly what happens and in what order. A call hides both. Bugs hide in the gap between what a function's name promises and what it does, and in calls that happen in an unexpected order or more than once.
- **Premature abstraction is costly.** A function extracted before its second real use bakes in a guess about the right interface. Undoing a wrong guess costs more than extracting late. Casey Muratori's *semantic compression* makes the same point from the other side: write the concrete code first, and compress it only once real repetition shows its shape.
- **Long is not complex.** A long, linear function is often easier to follow than the same logic spread over five shallow helpers. That matches Ousterhout's *shallow module* red flag.

The tool takes these as defaults: one-consumer indirection should be justified, not assumed, and inlining is the first remedy considered for small single-use units.

### Rule of three, as a prompt for judgement

The rule of three is a point where judgement should happen, not a rule in either direction:

- **Fewer than three instances** is not, by itself, a reason to remove an abstraction, and **three or more** is not, by itself, a reason to create one or keep it.
- At the third instance, *consider* whether the pieces share a reason to change. Co-change history is the best evidence: if the call sites change together, a shared unit pays. If they change independently, they are coincidental duplicates, and a shared helper would couple them.
- A unit with one consumer can still be worth keeping. It may encode a domain rule that needs a single source of truth, or carry a name that explains the code better than the code does.

Consumer counts therefore choose a *default* recommendation. Guards and agent judgement can change it, and every change is recorded.

## Scope

In scope:

- Finding symbols, files and whole branches of code that sit far from their consumers.
- Moving them closer, or inlining them when they are small and have one consumer.
- Removing indirection that lacks evidence of reuse: pass-through functions, single-use wrappers, barrel re-exports with one consumer.
- Scrutinising widely used utilities for design red flags.
- Measuring whether changes became cheaper after a tidy-up.

Out of scope:

- Creating helpers or abstractions. The tool never creates them.
- Replacing thin wrappers or re-implementations with standard-library idioms. That is the separate *idioms* plugin on the [roadmap](suite.md#roadmap).
- Extracting duplicated code into shared helpers.
- Moves across published package or deployable boundaries. These are flagged, never applied. Whether the package boundaries themselves are right is the [packaging](packaging.md) skill's question.

## Concepts

Distance is the heuristic. Consumer evidence picks the default remedy. Judgement confirms or overrides it.

**Distance.** The suite's tree distance (see [suite.md](suite.md#shared-vocabulary)) between a definition and a consumer.

**Net distance.** The weighted sum of tree distances on all a unit's boundary edges: incoming (consumers) and outgoing (its own dependencies outside the unit). Weights are reference counts, raised by co-change where there is history. Counting outgoing edges stops a unit from being "moved closer" to its callers by moving it away from what it depends on.

**Target location.** The folder that minimises net distance: a weighted median over the folder tree. It is found deterministically by evaluating the folders on the paths between the unit's edge endpoints, with ties broken by shallower depth and then path order. When the unit has no outside dependencies, this is the LCA of its consumers. A unit's **gain** is its current net distance minus its net distance at the target.

**Blocker.** A boundary edge that stops a move from realising its gain. It is a dependency from the unit onto code that stays behind (a sibling with its own outside consumers), an edge that would form a cycle at the target, or a stray. Blockers are tight coupling made visible.

**Consumers.** Direct callsites, counted separately from other references (passed as a value, registered, decorated) and from test references. Production consumers decide the target. Tests do not pull a unit towards themselves. A unit's own tests move with it.

**Movable unit.** A dominator subtree of the production import graph. File A dominates file B when every import path reaching B from an entry point goes through A. A and everything it dominates move together. Subtrees nest, so a unit can be one symbol, one file or a whole branch. Tests that import only files inside a unit belong to it and move with it.

**Stray.** A file that looks as if it belongs to a unit but has its own outside consumer. It forces a split, or it stays behind.

**Fan-in.** Distinct production consumer files. High fan-in units are scrutiny candidates.

**File cohesion.** How much the consumers of a file's exported symbols overlap. Build a graph of the file's exports, linking two exports when they share consumers or reference each other, and count its connected components. One component means the file is cohesive. Several components with disjoint consumers in different folders mean coincidental cohesion: the file is several units sharing a name, and each should go to its own consumers. It is related to LCOM (lack of cohesion of methods), applied at module level.

## Architecture

Determinism goes wherever the operation is mechanical. The agent handles judgement and semantic edits.

- **Analyser** (`locality analyse`): reads the repository and the shared history cache and emits ranked candidates as JSON. It never edits code.
- **Skill** (`locality`): holds policy, thresholds and commit discipline, and reviews candidates against red flags.
- **Mover** (`locality move`): relocates a unit and rewrites boundary-crossing imports. It defaults to a dry run and requires `--apply`.
- **Agent**: performs inlines in their own commits.
- **Measurement** (`locality measure`): reads history and session transcripts.

Packaging follows [suite.md](suite.md#plugin-anatomy). The bundle bundles the shared `history`, `parse` and `graph` packages, so it can refresh the shared cache itself (`locality history refresh`) without the cochange plugin. LSP plugins for the main languages are recommended alongside it, to confirm references before each move.

## Analysis pipeline

1. **Parse.** The tree-sitter adapter extracts imports, exports, definitions and callsites per file. Results are cached by blob SHA.
2. **Resolve.** Per-language resolvers turn import specifiers into files and symbols: tsconfig `paths` and package `exports`, Python package roots. Re-exports and barrel files (`index.ts`, `__init__.py`) are followed through to the real definition, and each barrel is itself recorded as a candidate for removal.
3. **Build the graph.** Symbol-level and file-level import graphs, with a virtual root importing every production entry point: app entries and configured dynamic entries. Test entries form a separate graph, used to assign tests to units. Files the virtual root cannot reach have no dominator. They are reported in an `unreachable` list (dead code, or an entry point missing from config) and take no part in unit finding until that is settled.
4. **Find units.** Each candidate unit is a node plus the subtree it dominates in the production graph:
   - **Condense cycles first.** Collapse strongly connected components (Tarjan) into single nodes, so a cycle can only move whole, then expand them back into files in the output.
   - **Dominators by Cooper–Harvey–Kennedy** over the condensed graph from the virtual root. It is simple, runs fast on graphs the size of import graphs, and its result (the dominator tree) is unique whatever order nodes are visited in, so units are deterministic. Lengauer–Tarjan is asymptotically faster but not needed at this scale.
   - **Multi-entry units.** Dominators only find units with one entry file. A sibling set *S* (files in one folder sharing internals) is also a unit when every edge into *S* ∪ dom(*S*) from outside lands on a file in *S*. Candidates come from folders whose dominated subtrees overlap, and each is checked with that condition.
   - **Symbol level.** The same computation on the symbol graph yields symbol units, used for `split` and for inlining single functions.
5. **Score.** For each unit, compute its net distance, target, gain, fan-in, blockers and evidence. For each blocker, also compute the *unblocked gain*: what the move would gain if that blocker were resolved.
6. **Signal.** Compute red-flag signals: pass-through bodies, vague names (`utils`, `helpers`, `common`, `misc`), exports with no outside consumer (*overexposure*), and caller-specific branching in high fan-in units (*special-general mixture*).
7. **Enrich.** Join age, churn and directional co-change from the history cache, refreshing it first when it is stale.
8. **Recommend.** Apply the rules below and emit ranked candidates.

### History-only mode

For languages without a structural adapter, and as a cross-check where there is one, the analyser runs a language-agnostic mode that uses co-change in place of the import graph:

- A file's "consumers" are its co-change partners, weighted by confidence, above minimum support.
- The target, net distance and gain are computed the same way over those weighted edges.
- Units are single files, or co-change clusters, rather than dominator subtrees, because without an import graph there are no dominators.
- Recommendations are limited to `move` and `review`, never `inline` or `split`, which need symbols. Moves are performed by the agent, with no deterministic mover.
- Every candidate is marked `source: history`, and the mode needs `moderate` or `strong` evidence ([suite.md](suite.md#evidence-strength)). On young repositories it reports nothing rather than guessing.
- Change spread cannot be the outcome for these moves. The target minimises the same distances spread measures, so spread would fall by construction. Agent effort is the outcome, and spread is a leading indicator only.

Where both modes run, disagreement is itself a finding. A file the import graph says is well placed but whose co-change partners are all elsewhere has *hidden coupling* (see [structure](structure.md#concepts)).

Each candidate carries:

| Field | Meaning |
|---|---|
| `unit` | Root file or symbol, plus the dominated files and owned tests that move with it |
| `location` / `target` | Current folder and proposed folder |
| `distance` | Current distance to target, in folder hops |
| `directCalls` | Direct callsites, with paths |
| `otherRefs` | References that are not calls (value, registry, decorator) |
| `testRefs` | References from tests, split into owned and external |
| `fanIn` | Distinct production consumer files |
| `size` | AST nodes and lines |
| `ownDeps` | Imports the unit itself makes |
| `visibility` | Module-private, exported, or exported from a package entry point |
| `age` / `lastChanged` | First and latest commit dates |
| `churn` / `coChange` | From the history cache: unit churn, and co-change between the unit and each consumer and among consumers |
| `signals` | Red-flag signals that fired, by name |
| `strays` | Files that block a clean move of the whole unit |
| `gain` | Net distance saved by moving to the target, as things stand |
| `blockers` | Edges that prevent or shrink the gain, each with its kind (dependency, cycle, stray), co-change with the unit, and unblocked gain |
| `cohesion` | For files: export component count, and the consumer folders of each component |
| `recommendation` | `inline`, `move`, `split`, `blocked`, `keep`, `scrutinise` or `review`, with the rule that fired |

## Recommendation rules

Recommendations are deterministic: the same repo, config and history always produce the same proposals. They are defaults for the agent to confirm or override, and every override is recorded with a reason.

Rules for units whose gain exceeds the configured minimum:

| Consumers | Size | Default |
|---|---|---|
| 1 | Tiny (fixed import overhead outweighs content) | `inline` |
| 1 | Medium | `inline` if the consumer stays readable, otherwise `move` next to the consumer (same file or sibling) |
| 1 | Large | `move`, kept as its own module next to the consumer |
| 2 | Any | `move` to the target (the consumers' LCA when the unit has no outside dependencies), or `review` when co-change between the two consumers is low, because independent consumers suggest coincidental reuse and inlining into each may be better |
| 3+ | Any | `review`: this is the point to judge whether the consumers share a reason to change. With high co-change among consumers, the distance is earned (`keep`). With low co-change, consider moving or inlining where consumers diverge. |

Rules for any unit regardless of distance:

| Condition | Default |
|---|---|
| Fan-in at or above the configured high threshold | `scrutinise`: location is earned, so review the design (see below) |
| Pass-through signal with one consumer | `inline` |
| Barrel file with one consumer of each re-export | `inline` (rewrite imports to the real definition) |
| File with two or more export components whose consumers sit in different folders | `split`: each component becomes its own unit and is then scored and recommended on its own |

Guards that turn any recommendation into `review` or `keep`:

- **Grace period.** A unit younger than the configured age (default 90 days) is skipped for `inline` and `move`. One callsite is only evidence once reuse has had time to happen.
- **Other references.** Any non-call reference means callsite counts are unreliable.
- **Visibility.** Exported from a package entry point means outside consumers may exist.
- **Interfaces, overrides and recursion.** These are not free-standing helpers.
- **Cycles.** A move that would create an import cycle is refused. Existing cycles are the [structure](structure.md) plugin's concern. Its evidence packs flag a misplaced symbol whose locality move would break the cycle.
- **Fixed points.** Framework conventions (routes, migrations, app folders) and layer rules limit where code may go.
- **Strays.** A unit with strays is split, or its strays stay behind.
- **Blockers.** A unit whose gain is below the minimum but whose unblocked gain is above it becomes `blocked`, not `keep` (see below).
- **Depth cap.** A target deeper than the configured maximum nesting is clamped, so the score cannot be gamed by burying code.

### Blocked moves

Many moves are prevented by tight coupling: the unit depends on its neighbourhood as much as its consumers depend on it. `blocked` units are reported in their own ranked list, by unblocked gain, because they show where breaking coupling would pay off. Each blocker leads to one of four outcomes, chosen by judgement from its evidence:

| Blocker evidence | Likely outcome |
|---|---|
| Blocker's other consumers are few and near the target | **Grow the unit.** Move the blocker with it as one commit, accepting it as part of the unit. |
| High co-change between unit and blocker | **Accept the coupling.** The distance is earned, and the pair belongs together wherever it lives. Re-score them as one unit. |
| Blocker is a file with unrelated export groups | **Split** the blocker first, then re-analyse. |
| Low co-change, both sides active (the *incidental* quadrant in [structure](structure.md#concepts)) | **Break the dependency** with the structure skill, using its evidence pack, then re-analyse. |
| Low co-change because the blocker rarely changes (a *stable* dependency) | **Move anyway** if the gain survives the longer edge to the blocker. A stable dependency costs little at any distance. |

When a blocker is resolved, the work lands in order: the split or break first as its own commit, then a re-analysis, then the move. The re-analysis is required, because resolving one blocker changes the graph and may change the target.

### Scrutinising widely used utilities

High fan-in units are where defects and awkward interfaces cost most, because every consumer inherits them. A `scrutinise` recommendation sends the unit to the skill's review checklist:

- **Red flags** from [red-flags.md](red-flags.md), especially *shallow module*, *special-general mixture* (caller-specific flags or branches), *overexposure* (options most callers never pass), *pass-through method* and *vague name*.
- **Correctness under all callers.** Edge cases one caller relies on and another violates: null and empty inputs, time zones, locale, error handling, mutation of arguments.
- **Divergent use.** Consumers that wrap, post-process or partly re-implement the utility suggest it does the wrong thing for them.
- **Standard-library overlap.** Noted for the idioms plugin, not fixed here.

The output is findings with red flags named. Any fix is a normal refactoring with its own commit and tests, and changes to the interface are reviewed with all consumers in view.

### Agent judgement

Judgement covers what the rules cannot see:

- A helper that encodes a domain rule needing one source of truth stays, however small.
- A name that carries real meaning may justify a move instead of an inline.
- A direct test may be redundant if the caller's tests cover the behaviour, or may be a seam worth keeping.
- At three or more consumers, whether they share a reason to change.

## Applying changes

Every commit is a single, revertible refactoring step. A reviewer never evaluates a move and a behaviour change at the same time.

- **Move first, deterministically.** File relocation plus import-path rewriting, using the per-language tooling in [suite.md](suite.md#language-notes): ts-morph for TypeScript/JavaScript, file moves for C# (a namespace change is a separate commit), include and build-target edits for C++, or LSP `workspace/willRenameFiles` where the server supports it. Where no deterministic tool exists, the agent performs the edit in a move-only commit, and the mover verifies it reproduces the planned file operations. The unit's internal layout and owned tests are preserved, so only boundary-crossing imports change. The mover reports the exact file operations in dry run, and the skill shows them before `--apply`.
- **Split before moving.** A `split` is its own commit: symbols move to new sibling files with imports rewritten, and nothing else changes. The resulting units are then moved or inlined in later commits.
- **Inline second, as its own commit.** The agent performs it: parameter substitution, name collisions, side-effect order and early returns.
- **One unit per commit.** Tests green between commits.
- **Leaves before roots.** For nested units, the smallest moves land first.
- **Mind in-flight work.** Units with recent churn are deferred, since open branches are likely touching them. Old, stable units are the cheapest moves and still pay off on every agent read.
- **Rename-friendly moves.** A move commit contains only the move and import rewrites, so git's rename detection keeps the file's history intact for future co-change analysis.
- **Commit message records the evidence.** The rule that fired, the consumer count, any red flag cited, and any agent override with its reason. It ends with the `Code-Health:` trailer that keeps the commit out of outcome windows ([suite.md](suite.md#measurement-across-the-suite)).

## Measurement

The tool succeeds if future changes get cheaper. Agent effort is the independent test of that. Change spread is the second outcome, with a caveat: targets are weighted by co-change, so co-locating files that change together lowers spread by construction. A fall in spread shows that changes now land closer together. It takes a fall in agent effort to show they got cheaper, and a spread improvement without one is reported as unproven. The static score only shows the tool did what it says.

| Measure | Source | What it shows | Role |
|---|---|---|---|
| Change spread: mean tree distance between files touched in the same logical change | History cache | Changes land in fewer, closer folders | Outcome, partly by construction |
| Agent effort: files read, hops, wasted reads and tokens per task | Claude Code session transcripts (Read, Grep, Glob calls) | Navigation cost for agents | Primary outcome |
| Read heat per file | Session transcripts | Where scattering costs most; ranks candidates | Prioritisation |
| Total weighted import distance (net, both directions) | The analyser | The tool removed distance rather than relocating it | Leading indicator only |
| Single-file folder count and maximum depth | The analyser | Code is not being buried to game the score | Gaming check |

Baseline both outcome measures before the first tidy-up, then compare over a matching window afterwards. `locality measure baseline` records the baseline in `.code-health/local/`, outside the cache, because it cannot be regenerated once the code has moved. `locality measure compare` reports the change with sample sizes, beside the same figures for similarly ranked candidates that were left alone ([suite.md](suite.md#measurement-across-the-suite)).

## Configuration

In the `locality` section of the suite config:

- Minimum distance worth reporting.
- Size thresholds for tiny, medium and large.
- High fan-in threshold for `scrutinise`.
- Grace period before a single callsite counts as evidence.
- Co-change thresholds for the two- and three-consumer rules.
- Fixed points and layer rules.
- Maximum nesting depth for targets.

Entry points (including dynamic ones the parser cannot see), exclusions and history settings live in the suite-wide part of the config.

## Decisions

These were open questions in the strawman. Each decision can be revisited with evidence.

- **First language: TypeScript/JavaScript**, then C#, then C++ (see [suite.md](suite.md#languages)). TypeScript has ts-morph for deterministic moves, and the suite itself is written in it. C# and C++ need symbol-based dependency resolution, and their moves touch namespaces or build files.
- **Tests do not decide targets.** Production consumers decide where code goes. Tests decide whether to inline (a unit with its own tests may be a deliberate seam), and owned tests move with their unit.
- **Default grace period: 90 days**, configurable.
- **Transcript aggregation: local by default.** Only file paths and counts are extracted. Team aggregation is an explicit export of counts and repo-relative paths, never content.

## Open questions

- Whether `split` (symbols out of a mixed file) belongs in the deterministic mover, which ts-morph supports, or stays agent-performed.
- Whether to rename the plugin `cohesion`. The term is more widely recognised. `locality` names what the tool actually measures and changes.
- How to identify dynamic entry points (DI containers, plugin registries, framework file conventions) without per-framework config.
- What high fan-in threshold to use by default. It is likely relative (a top percentile) rather than absolute.

## Milestones

1. Analyser for TypeScript/JavaScript: graph, dominator units, scored candidates as JSON.
2. Deterministic recommendations, file cohesion and `split`, red-flag signals and config.
3. Plugin packaging: bundled CLI, skill with `allowed-tools`, evals and marketplace entry.
4. History enrichment: age, churn and co-change from the shared cache.
5. `measure baseline`: change spread and transcript metrics, recorded before anything moves.
6. Deterministic mover through ts-morph.
7. `scrutinise` review workflow for high fan-in units.
8. `measure compare`, with the comparison group.
9. C#, then C++.
