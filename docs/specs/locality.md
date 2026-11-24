# Locality Refactoring Tool — Spec

Part of the code-health suite. Read [suite.md](suite.md) for packaging, the CLI contract, config, caches and testing, and [red-flags.md](../../shared/red-flags.md) for the design vocabulary the skill uses.

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

**Target location.** The folder that minimises net distance: a weighted median over the folder tree. It is found deterministically by evaluating the folders on the paths between the unit's edge endpoints, with ties broken by shallower depth. When two or more allowed folders at the same depth, neither containing the other, have the same lowest distance, the choice would be arbitrary, so no target is proposed (the target is the current folder, the gain is 0) and the tied folders are reported. When the unit has no outside dependencies, this is the LCA of its consumers. A unit's **gain** is its current net distance minus its net distance at the target.

**Blocker.** A boundary edge that stops a move from realising its gain: an outgoing edge from the unit to code that stays behind (a sibling with its own outside consumers) and whose removal would raise the gain. It is a `stray` when the code lies under the unit's base folder, and otherwise a `dependency`. Each blocker carries its `unblockedGain`, and blockers sort by it. Blockers are tight coupling made visible. File-level import cycles are condensed into one unit, so a cycle is never a blocker. A move that would create a cycle between folders is handled by the cycle guard.

**Consumers.** Direct callsites, counted separately from other references (passed as a value, registered, decorated) and from test references. Production consumers decide the target. Tests do not pull a unit towards themselves. A unit's own tests move with it.

**Movable unit.** A dominator subtree of the production import graph. File A dominates file B when every import path reaching B from an entry point goes through A. A and everything it dominates move together. Subtrees nest, so a unit can be one symbol, one file or a whole branch. Tests that import only files inside a unit belong to it and move with it.

**Stray.** A file that looks as if it belongs to a unit but has its own outside consumer. It forces a split, or it stays behind.

**Fan-in.** Distinct production consumer files. High fan-in units are scrutiny candidates.

**File cohesion.** How much the consumers of a file's exported symbols overlap. Build a graph of the file's exports, linking two exports when they share consumers or reference each other, and count its connected components. One component means the file is cohesive. Several components with disjoint consumers in different folders mean coincidental cohesion: the file is several units sharing a name, and each should go to its own consumers. It is related to LCOM (lack of cohesion of methods), applied at module level. CodeScene's Low Cohesion finding uses LCOM4, which is also a count of connected components, over methods that share fields. Two exports are linked when they share a consumer file or when one's source mentions the other's name. Only exported functions, methods and classes are units, so constants and types are not part of the graph. A file is mixed when two components have non-empty, disjoint sets of consumer folders. The name-mention link is a text heuristic, and it can link two exports that are unrelated or miss a link, so a `split` is for the agent to confirm.

## Architecture

Determinism goes wherever the operation is mechanical. The agent handles judgement and semantic edits.

- **Analyser** (`locality analyse`): reads the repository and the shared history cache and emits ranked candidates as JSON. It never edits code.
- **Skill** (`locality`): holds policy, guidelines and commit discipline, and reviews candidates against red flags.
- **Mover** (`locality move`): relocates a unit and rewrites boundary-crossing imports. It defaults to a dry run and requires `--apply`.
- **Report** (`locality report locality`): renders the candidates as an HTML or Markdown page, as [Reports](suite.md#reports) defines. It shows the candidates in three tables by kind, because the kinds are not comparable: the top 15 of kind move (the planner plans these without `--reason`), the top 10 of kind review, split or inline, and the top 10 of kind scrutinise ordered by consumer files (the consumer files are the distinct production files that use the unit, the same count the guideline and the order use, and test files are not counted). The move and review tables show gain as net distance removed, "Gain ÷ guideline" (the gain divided by `locality.minDistance`), target, unit files, consumer files and folders, distance and confidence; the scrutinise table shows consumer files, "Consumer files ÷ guideline" (divided by `locality.highFanIn`), consumer folders and confidence, and no gain, because the fan-in rule chose the unit and proposes no move. The move table lists at most one Go move into each folder that holds no Go file (the one with the highest gain), because a folder holds one package; the others are counted in the omitted table as "another proposed move lands in the same empty folder". A unit of kind blocked, and a unit of kind move that has blockers, is listed only in the blocked table, which shows its kind, its gain now, and its gain if the blockers were resolved. A folder unit (a sibling set or branch) at or under `locality.maxMoveFiles` stays a candidate when its target is inside the same project, as a review, and its size shows in the unit files column; a folder whose target crosses a package boundary is refused as no usable target and is not ranked. The target of the repository root prints as "the repository root (/)". The report shows a dry-run move plan for each of the first 10 of the moves followed by the reviews and splits (files moved, imports rewritten, and files outside the move edited, which counts the files whose text changes, including a reference renamed to follow a name that moved package and so changes no import; never `--apply`), a histogram of consumer distance, the unresolved imports by reason, and what was omitted by reason with counts (the units with no proposed move by reason, the top 10 of them with their detail, and the units recommended blocked with their first 3 blockers). Each candidate shows its `reason` sentence and, when present, `unusableTarget` ("a better folder, X with gain N, is refused: reason"). A dry-run plan prints the warnings the mover returned (up to 3, then a count). In the units with no proposed move table, a unit whose own folder is the best prints "stays" as its target. A refused move plan is one line: the refusal codes with counts and the first detail cut to 120 characters. Slots: a verdict (`do-it`, `do-it-differently`, `leave`) with the reason and the risk for each planned candidate, one for the whole report and one for the limits.
- **Agent**: performs inlines in their own commits.
- **Measurement** (`locality measure`): reads history and session transcripts.

Packaging follows [suite.md](suite.md#plugin-anatomy). The bundle bundles the shared `history`, `parse` and `graph` packages, so it can refresh the shared cache itself (`locality history refresh`) without the cochange plugin. LSP plugins for the main languages are recommended alongside it, to confirm references before each move.

## Analysis pipeline

1. **Parse.** The tree-sitter adapter extracts imports, exports, definitions and callsites per file. Results are cached by blob SHA.
2. **Resolve.** Per-language resolvers turn import specifiers into files and symbols: tsconfig `paths` and package `exports`, Python package roots. Re-exports and barrel files (`index.ts`, `__init__.py`) are followed through to the real definition, and each barrel is itself recorded as a candidate for removal.
3. **Build the graph.** Symbol-level and file-level import graphs, with a virtual root importing every production entry point: app entries and configured dynamic entries. Test entries form a separate graph, used to assign tests to units. Files the virtual root cannot reach have no dominator. They are reported in an `unreachable` list (dead code, or an entry point missing from config) and take no part in unit finding until that is settled.
   - **Entry points.** Configured `entryPoints` globs are used exactly. Where none are configured, an entry is every production file nothing imports, plus one file per cycle that no entry reaches, and each package boundary adds its own entry files. This picks up scripts and dead files as entries, which is why `unreachable` and the reported entry list (`inputs.entries`, with `inputs.entrySource`) are part of the output: a wrong entry is visible there. Entry files are never candidates.
   - **Edge weight.** An edge from a consumer to a unit weighs `max(1, calls + references)`. When history is on (`locality.useHistory`), the co-change support of the pair is added to it. A recommendation can therefore differ between a run with history and a run without. Edges from consumers to barrels are not counted, and neither are edges from files the virtual root cannot reach.
4. **Find units.** Each candidate unit is a node plus the subtree it dominates in the production graph:
   - **Condense cycles first.** Collapse strongly connected components (Tarjan) into single nodes, so a cycle can only move whole, then expand them back into files in the output.
   - **Dominators by Cooper–Harvey–Kennedy** over the condensed graph from the virtual root. It is simple, runs fast on graphs the size of import graphs, and its result (the dominator tree) is unique whatever order nodes are visited in, so units are deterministic. Lengauer–Tarjan is asymptotically faster but not needed at this scale.
   - **Multi-entry units.** Dominators only find units with one entry file. A sibling set *S* (files in one folder sharing internals) is also a unit when every edge into *S* ∪ dom(*S*) from outside lands on a file in *S*. Candidates come from folders whose dominated subtrees overlap, and each is checked with that condition.
   - **Symbol level.** The same computation on the symbol graph yields symbol units, used for `split` and for inlining single functions.
   - **Unit identity.** A candidate's path is its entry file, or the folder for a sibling set. A sibling set is kept only when its entries share internals that no single entry dominates. A barrel with exactly one live importer is its own `inline` candidate (rule `single-consumer-barrel`) and the branch behind it is not folded into it. A barrel with more importers carries a `barrel` signal.
   - **Scattered units.** A dominator unit with files outside its entry file's folder is `review` (rule `scattered-unit`) instead of `move` or `inline`, and its leaves are scored on their own. Any file outside the entry folder triggers it. It is a guard that asks for a look, not a measure of how scattered the unit is.
5. **Score.** For each unit, compute its net distance, target, gain, fan-in, blockers and evidence. For each blocker, also compute the *unblocked gain*: what the move would gain if that blocker were resolved.
6. **Signal.** Compute red-flag signals: pass-through bodies, vague names (`utils`, `helpers`, `common`, `misc`), exports with no outside consumer (*overexposure*), and caller-specific branching in high fan-in units (*special-general mixture*).
7. **Enrich.** Join age, churn and directional co-change from the history cache, refreshing it first when it is stale. When `locality.useHistory` is true these feed the recommendation: age drives the grace period, co-change among consumers drives the two- and three-consumer rules, and co-change raises edge weights. When it is false, or the history is weak, those fields are null and the rules that need them read the consumer count alone. Under weak evidence a history-based field is tentative and does not overturn a structural recommendation.
8. **Recommend.** Apply the rules below and emit ranked candidates.

### History-only mode

For languages without a structural adapter, and as a cross-check where there is one, the analyser runs a language-agnostic mode that uses co-change in place of the import graph:

- A file's "consumers" are its co-change partners, weighted by confidence, above minimum support.
- The target, net distance and gain are computed the same way over those weighted edges.
- Units are single files, or co-change clusters, rather than dominator subtrees, because without an import graph there are no dominators.
- Recommendations are limited to `move` and `review`, never `inline` or `split`, which need symbols. Moves are performed by the agent, with no deterministic mover.
- Every candidate is marked `source: history`, and the mode needs `moderate` or `strong` evidence ([suite.md](suite.md#evidence-strength)). On young repositories it reports nothing rather than guessing.
- Change spread cannot be the outcome for these moves. The target minimises the same distances spread measures, so spread would fall by construction. Agent effort is the outcome, and spread is a leading indicator only.

Details that the bullets leave open:

- **Consumers.** A partner is a consumer when it shares at least `historyMinSupport` logical changes with the unit and those changes are at least `historyMinConfidence` percent of the unit's. Its weight is `max(1, round(support × confidence / 100))`. The defaults, 5 and 30 percent, are the same as `cochange.minSupport` and `cochange.minDegree`, and are Tornhill's code-maat defaults. The support count is a floor: a coupling from fewer shared changes is not meaningful. The confidence percentage is a guideline.
- **Units.** A unit is a file, or a connected group of files in one folder whose pairs each share at least `historyMinSupport` changes and change together at least `highCoChange` percent of the time.
- **Sort.** The gain is measured in folder hops, the unit structural candidates use, so the `minDistance` guideline applies to it. Each candidate has `scoreUnit: gain` and a `ranking` (the gain, `minDistance` and their ratio). Candidates sort by `ranking.ratio` descending, then gain descending, then path, the same `ratio-to-guideline` method as structural candidates. Because every history candidate is read against the same guideline, this order equals the order by gain. No guideline applies to co-change strength (support and confidence are floors and guidelines for what counts as a partner, not measures of how far a unit is from its place), so the sort does not use it. JSON carries `historyOnly.sortMethod`, and the table prints a line naming the method. The table also prints a notice with the `omitted` count for each reason.
- **Mutual pulls.** Candidates are processed by that order. When the files of a lower candidate are partners of a kept one, the lower one is dropped, which prevents advice to move A to B and B to A. The kept candidate lists what it superseded in `supersedes` (path and gain), and `historyOnly.omitted.superseded` counts them.
- **What is reported.** Only `move` and `review`. Conclusions that would be `keep` are not listed as candidates. `historyOnly.omitted` counts them by reason, so nothing is dropped without a count: `earned-distance` (three or more partners that change together), `fixed-point`, `near-partners` (gain below the `minDistance` guideline) and `superseded`. A unit inside the grace period is a `review`.
- **Storage.** `--source history` and `--source both` output is never written as the `locality.analyse` report, because that report is the structural analysis other commands read.

#### Report contract

`reports/locality.analyse.json` is the stored structural analysis. It carries the envelope fields of every document ([suite.md](suite.md#cli-contract)), including `schemaVersion`, which is `1`. The `structure` plugin reads it ([structure.md](structure.md#locality-report-contract)): it uses `schemaVersion`, `tool`, `command`, `repo.head`, `repo.dirty`, `config` and `results`, and from each result its `path` or `id` and its `blockers` (`from`, `path`, `unblockedGain`). A change to any of these, or to what they mean, bumps `schemaVersion`, and a reader that finds a version it does not know ignores the report. The command's JSON schema (`schemas/analyse.schema.json`) pins the version.
- **Hidden coupling.** Under `--source both`, a history candidate is hidden coupling when none of its unit's files is in a structural candidate whose gain is at or above `minDistance`, and none of its partners is a file the unit imports or is imported by. The import check is made in both directions. The result carries `guidelines.gain` like any candidate.

Where both modes run, disagreement is itself a finding. A file the import graph says is well placed but whose co-change partners are all elsewhere has *hidden coupling* (see [structure](structure.md#concepts)). CodeScene reports the same signal as change coupling between files that have no dependency.

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
| `reason` | One sentence that says why the unit has its recommendation, with the values behind it (consumer count, co-change degree beside its guideline, age beside `graceDays`). For a recommendation other than `move` it says that `locality move` needs `--reason` |
| `unusableTarget` | Present only when a better folder exists that the placement rules refuse: `target`, `gain` and the rule |
| `score` / `scoreUnit` | The ranking figure and what it counts: `gain`, `unblocked-gain` (blocked), `component-gain` (split, the larger of the file's gain and the components' summed gains) or `fan-in` (scrutinise). A score is comparable only within one `scoreUnit`. The JSON and text output of `analyse` keep one list sorted by `ranking.ratio` descending, then score descending, then path. `ranking` reads the score against the guideline of its unit (`highFanIn` for `fan-in`, `minDistance` for the others), so a candidate that is twice past its guideline sorts above one that is 1.5 times past it whatever they count. A `scrutinise` row's ratio is its fan-in over `highFanIn`, not a gain, so a scrutinise unit with gain 0 can sort above a move: filter with `--recommendation` or read `locality report locality`, which groups by kind. `fanInPercentile` is the percentage of the repository's units whose fan-in is at or below the unit's, shown for information and read by nothing. `--recommendation` lists one kind |
| `guidelines` | `gain` beside `minDistance` and `fanIn` beside `highFanIn`, each as `value`, `guideline` and `ratio` (value divided by guideline). A ratio above 1 is past the guideline |
| `confidence` | Present only for C and C++ units whose result rests on an include that found no file: `{ "level": "low", "reason" }`. One of the unit's files has an include of its own that found no file, so a dependency may be missing, or an include elsewhere names one of its files and found none, so a consumer may be missing. What the result says about consumers, "no production consumers" included, is then a lower bound. The key is absent otherwise. The output's `includeResolution` section and the `unresolvedIncludePercent` guideline (default 20 percent, a judgement call) are described in suite.md |
| `blockers` | Edges that prevent or shrink the gain, each with its kind (dependency or stray), co-change with the unit, and unblocked gain |
| `cohesion` | For files: export component count, and the consumer folders of each component |
| `recommendation` | `inline`, `move`, `split`, `blocked`, `keep`, `scrutinise` or `review`, with the rule that fired |

## Recommendation rules

Recommendations are deterministic: the same repo, config and history always produce the same proposals. They are defaults for the agent to confirm or override, and every override is recorded with a reason.

### Guidelines and floors

The numbers below are guidelines for investigation. A guideline orders and annotates results, and does not decide whether a result exists. Each candidate reports the measured value, the guideline and their ratio (`guidelines`), and candidates sort by how far past their own guideline they are. Findings say "worth a look" or "above guideline". No command exits with 1 because a value is above a guideline. Only a command that gates explicitly does, such as `verify-move`.

A rule that picks a default remedy by comparing a value to a guideline (tiny, large, high fan-in) is a default for the agent to confirm, not a verdict. Units that fall under the `minDistance` guideline are the one case where a unit is left out of the candidates. They are counted in `summary.placed`, and `move` and `verify-move` still read them.

A unit with no proposed move is the other case. It is not ranked, `summary.omitted` counts it by reason, and `omitted` lists each with the reason, the figures and the guideline behind it. `move` and `verify-move` still read these units too. The reasons are `no usable target: <rule>` (the language placement rules, or the Go grouping folder rule in `groupingFolders`, refuse every target that would give the unit a gain at or above `minDistance`), `no single target: N folders tie` (N allowed folders at the same depth, none containing another, have the same lowest distance, so any one chosen would be arbitrary; `detail` lists them and no move is proposed), `folder-sized unit` (more files than `maxMoveFiles`) and `target is a root folder` (a unit of more than one file whose target is an ancestor shallower than `minTargetDepth`).

A floor is a minimum amount of evidence below which a statistic is meaningless, such as a degree from one shared change. Below a floor the tool reports the value as null or as low confidence, and says so.

| Setting | Default | Kind | Source of the default |
|---|---|---|---|
| `minDistance` | 2 | Guideline | Judgement call: one hop is within the unit's own neighbourhood |
| `tinyLines`, `largeLines`, `inlineHostLines` | 15, 150, 300 | Guidelines | Judgement calls. CodeScene's Large Method warning is 70 lines, so `largeLines` is looser because it picks a remedy and does not flag a smell |
| `unresolvedIncludePercent` | 20 | Guideline | Judgement call. Above it, C and C++ runs warn on stderr and print a notice. The share is reported whatever it is, and no unit is hidden |
| `highFanIn` | 8 | Guideline | Judgement call. It is absolute, not relative: a percentile of fan-in would flag the top few units in every repository |
| `graceDays` | 90 | Guideline | Judgement call |
| `lowCoChange`, `highCoChange` | 10, 40 percent | Guidelines | Tornhill's coupling-degree range of about 30 to 50 percent |
| `minCoChangeChanges` | 6 | Floor | Judgement call |
| `historyMinSupport` | 5 | Floor | code-maat's `min-shared-revs` and `cochange.minSupport` |
| `historyMinConfidence` | 30 percent | Guideline | code-maat's `min-coupling` and `cochange.minDegree` |
| `windowMonths` (shared `history.windowMonths`) | 12 | Setting | CodeScene advises 6 to 12 months for hotspot windows |
| `measureMinSamples` | 10 | Floor | Judgement call. A mean of fewer than ten tasks moves with any one task |
| `measureNoisePercent` | 10 | Guideline | Judgement call |
| `maxDepth` | 6 | Setting | Judgement call. A depth cap stops code being buried to lower its distance |
| `maxMoveFiles` | 20 | Guideline | Judgement call. A unit of more files than this is a folder, and moving it reorganises the code base instead of relocating one module. It is not proposed as a move and is counted in `summary.omitted`. 20 is above the largest multi-file units that looked like single modules in Orleans (19 files) and below the folders Solent proposed moving whole (58 and 76 files) |
| `minTargetDepth` | 2 | Guideline | Judgement call. A unit of more than one file is not moved up to an ancestor shallower than this (the repository root, or a top-level folder such as `src`). A single file still moves to its consumers' lowest common ancestor, whatever its depth |
| `groupingFolders` | `internal`, `pkg`, `cmd` | Guideline | Go layout roots: a Go folder is a package, so a file at the root of one of these folders would join a package of that name, which is not a home for code. A folder whose last path segment is in this list, and the repository root (a Go file there joins the module's root package), is never proposed as a move target for a unit that has a file of a language in `groupingLanguages`. The next best usable folder is tried; when none gives a gain at or above `minDistance` the unit is counted under `no usable target: target is a grouping folder`. `move --to` can still name such a folder, with a reason |
| `groupingLanguages` | `go` | Setting | Language adapter ids the `groupingFolders` rule applies to: the languages where a folder is a package. To apply the rule to another language, add its adapter id here and the layout root names to `groupingFolders` (for example `{"locality": {"groupingFolders": ["internal", "pkg", "cmd", "src"], "groupingLanguages": ["go", "java"]}}`). A folder named `src` is a legitimate target in TypeScript, so it is not in the default |

Rules for units whose gain is at or above the `minDistance` guideline:

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
| Fan-in at or above the `highFanIn` guideline | `scrutinise`: location is earned, so review the design (see below). The candidate reports fan-in as a ratio to the guideline, and `scrutinise` candidates sort by fan-in |
| Pass-through signal with one consumer | `inline` |
| Barrel file with one consumer of each re-export | `inline` (rewrite imports to the real definition) |
| File with two or more export components whose consumers sit in different folders | `split`: each component becomes its own unit and is then scored and recommended on its own |

Rules apply in this order, and a unit takes the first that fires: fixed point (`keep`), single-consumer barrel, mixed exports (`split`), high fan-in (`scrutinise`), no production consumers (`review`), pass-through, then gain below the guideline (`blocked` or `keep`), then the consumer-count rules. Guards apply only to `inline` and `move`. High fan-in comes before the other-references guard, so a widely used package entry is scrutinised and not reviewed. A fixed point is a `locality.fixedPoints` glob. A folder that matches one is never a target.

Guards that turn any recommendation into `review` or `keep`:

- **Grace period.** A unit younger than the configured age (default 90 days) is skipped for `inline` and `move`. One callsite is only evidence once reuse has had time to happen.
- **Other references.** Any non-call reference means callsite counts are unreliable.
- **Visibility.** Exported from a package entry point means outside consumers may exist. Package entries are the files named by the `main`, `module`, `types`, `bin` and `exports` strings of a non-private `package.json` (and the equivalent manifests of other languages) that resolve to a file in the tree. A target containing `*` in an `exports` map (a subpath pattern such as `./dist/features/*.js`) is matched against the files in the tree, `*` standing for any run of characters including `/`, so every file it matches is a package entry. A file exposed only through a wildcard is therefore recognised as one.
- **Interfaces, overrides and recursion.** These are not free-standing helpers. The language adapters supply them as optional unit facts (interface or abstract class, a method that overrides or implements an inherited one, a function that calls itself). This guard runs before the other-references guard, so a type-only import of an interface is not hidden by it.
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

- **Red flags** from [red-flags.md](../../shared/red-flags.md), especially *shallow module*, *special-general mixture* (caller-specific flags or branches), *overexposure* (options most callers never pass), *pass-through method* and *vague name*.
- **Correctness under all callers.** Edge cases one caller relies on and another violates: null and empty inputs, time zones, locale, error handling, mutation of arguments.
- **Divergent use.** Consumers that wrap, post-process or partly re-implement the utility suggest it does the wrong thing for them. The analyser reports a wrapper only when a function hands on at least one of its own parameters and fixes the rest with literals (partial application), and reports divergent use when two or more files post-process or work around the result. Each finding states the counts and consumer files it rests on, and is a place to look.
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
- **Any unit can be moved on purpose, and moved back.** `move` and `verify-move` also take a unit the analysis does not report because it already sits beside its consumers. The analyser recommends keeping it, so the move is an override: `--to` names the destination and `--reason` is required and recorded. That is how a unit goes back to where it was.
- **Hard guards.** An override covers only a recommendation that is not `move`. These guards refuse a move whatever the reason: a package entry, a fixed point (as source or destination), a package boundary, a name collision at the destination and a barrel. The mover also refuses an invalid destination and a move that changes nothing. A Go move into or out of an `internal/` directory is refused for the same reason as a package boundary. A Go folder is a package, so two more rules refuse a Go move: `import-cycle` (the file imports the package it would land in, so it would import its own package, or the move makes two packages import each other that did not before) `package-main` (a library file is never moved into a `package main` folder, and a `package main` file is never moved out of one) and `unexported-use` (an unexported name is reached only from its own package, so a Go file is not moved away from the same-folder files that use an unexported name it declares, nor away from the same-folder files that declare an unexported name it uses; the detail reads "unexported symbol used in its package: X used by Y"). A `_test.go` file of the package's own folder is part of the package for this rule: a test that uses only unexported names declared in the unit's files moves with the unit (role `test`), and the move is refused when such a test also uses an unexported name of a file that stays. `testdata`: a Go test file is not moved out of a folder that has a `testdata/` folder, because the test reads `./testdata` of its own package folder and the folder is not moved. A Go file moved into a folder that holds no Go file keeps its package name; the folder then holds that one package, so the report lists one such move per folder. The mover also refuses (`does-not-compile`) whatever it finds would leave the result not compiling: an unexported name reached from another package, a name declared in files that end up in different packages, a folder in no module, and an `internal/` import from outside its parent. Other languages have no such rule, because the analysis cannot tell cheaply and for certain that their move does not compile. The reason of an override is recorded in the commit message only.
- **Tests outside the unit.** Tests that import only the unit move with it. A test that lies outside the unit's folder is placed in the destination folder beside the unit. A mirrored test tree can therefore be left inconsistent, and the dry run lists every file operation so the agent sees it first.
- **Working tree and commit.** `--apply` commits by default, and `--no-commit` leaves the move staged. It refuses any dirty tree, untracked files included, because the commit must hold only the move. When git has no author identity it commits as `code-health <code-health@localhost>`.
- **Import rewriting.** Each specifier is resolved before and after the move, and one that no longer resolves is replaced by a relative specifier. The extension style the file used is restored after the rewrite. An alias that became relative is reported as a warning. A literal path in a module-path call (`jest.mock`, `jest.doMock`, `jest.unmock`, `jest.setMock`, `jest.requireActual`, `jest.requireMock`, `jest.createMockFromModule`, `jest.unstable_mockModule`, `vi.mock`, `vi.doMock`, `vi.unmock`, `vi.importActual`, `vi.importMock` and `require.resolve`) is rewritten like an import specifier, and `rewrites` lists it. A call whose path is computed (a concatenation, a template with substitutions, or a variable) cannot be rewritten. The mover prints a warning naming the file, the line and the call when the computed path, or the initialiser of the variable it names, contains the name of a moved file without its extension, and the agent checks it by hand. Documentation, config and scripts that mention a moved path are reported as mentions and are not edited, so the agent decides on each one.
- **Language movers.** `mover.kind` in an adapter (`codemod`, `file-move` or `agent`) describes the language's mover and is metadata only: no command branches on it. `codemod` means the edits are computed deterministically, which holds for every language except C#, where the move changes no name (`file-move`). C++ is a `codemod`: it computes the `#include` and CMake source-list edits without a compiler front end. No registered language is `agent`. After a move, an external tool (Roslyn, rust-analyzer, rope, clangd, gopls, jdtls, Kotlin LSP) confirms references when installed. The outcome is `confirmed` or `not confirmed`. A missing tool, a tool that fails and a tool that cannot judge are all `not confirmed`, and none of them fails the move. Roslyn compares the errors before and after by file, code and message. clangd counts only file-not-found, unknown-type and undeclared-name errors, because it cannot see the project's full build.
- **What a move rewrites.** A move rewrites imports and includes, and changes names only where the language requires it. C#: only `Compile` items are rewritten, and a namespace rename is the separate `update-namespaces` function, which warns about every case it does not handle. Java and Kotlin: a package clause that does not match its folder, or a destination outside the source root, keeps its package and warns. Go: the moved file keeps its package name unless the destination already has one, and a new import goes in the last group of the first parenthesised import block. C++: a destination outside every include directory gets a quoted relative include and a warning. A move can compile and still leave a namespace out of step with its folder, and the warning says so.
- **Verifying a move.** `verify-move` plans from the parent commit's analysis and requires the commit to reproduce the planned file text exactly. It is a gate and exits with 1 when the commit differs or lacks the `Code-Health:` trailer. A difference in the spelling of an import alone is listed in `specifierDifferences`, and it still fails, so that a person looks at it: the reviewer either matches the mover's spelling or explains the difference. It cannot verify a merge commit or a root commit.
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

Baseline both outcome measures before the first tidy-up, then compare over a matching window afterwards. `locality measure baseline` records the baseline in `.code-health/local/`, outside the cache, because it cannot be regenerated once the code has moved. The baseline records `sortMethod`, the way its candidates were ordered (`ratio-to-guideline`: by `ranking.ratio`, then score, then path), and each recorded candidate carries its `ratio`. `locality measure compare` exits with a usage error when the baseline's `sortMethod` is not the one the tool uses now, because ranks made by different methods do not pair like with like. The message says to take a new baseline with `--name`; the old one is left in place. A baseline recorded before `sortMethod` existed is refused the same way. `locality measure compare` reports the change with sample sizes, beside the same figures for similarly ranked candidates that were left alone ([suite.md](suite.md#measurement-across-the-suite)).

### How a comparison is made

- **Footprint.** The effect of acting on a candidate is measured over its footprint: the unit's files plus their production consumers. Change spread is measured over the logical changes that touch the footprint, and agent effort over the tasks that touch it. Consumers are included because co-locating a unit with its consumers is the benefit being measured, and the footprint is wider than the unit for that reason. Baseline paths are mapped to their identity at the baseline commit, and after-window tasks use the paths still present at HEAD. CodeScene measures at the file or component touched, which is narrower.
- **Acted on.** A candidate is acted on when a commit reachable from HEAD and not from the baseline, with a `Code-Health:` trailer whose first token is `locality` (or `locality/<rule>`), renamed or deleted one of its files. Edits do not count. A move made without the trailer is not attributed to the tool, because the outcome cannot tell a move the tool recommended from one that happened for another reason. The output reports `suite.untrailered`, the number of baseline candidates with a file renamed or removed by a commit without the trailer, so the reader can see what was not attributed. Those candidates are in neither group.
- **Comparison group.** For each acted-on candidate in rank order, the unused left-alone candidate of nearest baseline rank is taken, with ties going to the better rank. A left-alone candidate that shares a footprint file with an acted-on one is passed over and counted as `suite.overlapping`. A task that touches both a pair's acted-on footprint and another footprint is counted in each group it touches. That can bias a result towards no change, so a low `overlapping` count does not remove the caveat.
- **Windows.** The baseline window is `windowMonths` back from HEAD's committer date, in whole UTC days, including HEAD's day. The after window has the same number of days, starts the day after the last suite commit, and is cut at HEAD when HEAD comes first, in which case the output sets `complete: false`. History and transcripts are cut at the same days with the same filters. A comparison with `complete: false` is a partial look, and the reader should wait for the window to fill before relying on a conclusion.
- **Transcript source.** Sessions come from `~/.claude/projects`, or `--projects-dir`. The path is not echoed. Tasks of main sessions and of subagent transcripts are both read (`--source`), the files named in `Bash` commands count as reads and edits unless `--effort tools` is given, and a path inside a Claude Code worktree under `<root>/.claude/worktrees/<name>/` maps to the repo whether or not the worktree still exists. `inputs.transcripts` carries counts and a sha256 of the task list, and the checkouts read are the repository root and each `git worktree list` entry. Only paths and counts are read from a transcript, never prompt text.
- **Conclusions.** A difference is the acted-on change minus the comparison change. For each of the four figures the output carries the observed direction, the difference as a percent of the acted-on starting figure, and its ratio to `measureNoisePercent` (a guideline). A difference at or inside the guideline is `no-change`. When the smallest sample of the four arms is below `measureMinSamples` (a floor) the conclusion is `insufficient-sample`, the observed direction is still reported, and `lowConfidence` is true. Effort is `lower` when at least two of files read, folders visited, re-reads and tokens fell and none rose, and `higher` for the reverse. It is `no-change` when none fell or rose, and `mixed` in any other case, with every figure visible. This voting rule is a judgement call and not an established method. `cheaper` requires effort to have fallen, and a fall in spread alone is `spread-without-effort`.

## Maintainer commands

These are calibration tools, run by the suite's maintainers on a corpus of repositories. They stay runnable, but are left out of `--help` listings and of every skill and reference that end users or Claude follow.

### The premise check

`locality measure premise` asks, from history and sessions that already exist, whether tasks whose edited files lie further apart cost an agent more. A task's distance is the change spread of its edited files, so a task that edited fewer than two files is left out. The statistic for each cost figure (files read, re-reads, tokens) is the partial Spearman correlation of distance and cost with the number of files edited held constant, because larger tasks both spread further and read more, and a raw correlation would measure task size. It reports the correlation and its Fisher z. A |z| of 1.96 is the conventional 5 percent significance guideline, and a figure whose |z| is inside it is `no-relationship-shown`. A figure from fewer than `measureMinSamples` tasks is `insufficient-sample`. Tasks come from main sessions and from subagent transcripts ([suite](suite.md#measurement-across-the-suite) says how each is read, and how a path in a deleted Claude Code worktree maps to the repo). `--source main|subagent|all` (default `all`) chooses which are read, and the output gives the tasks, distance, figures and verdict for the chosen tasks and for each source it read (`bySource`), and counts subagent files measured and not measured in `sessions.subagents`. A subagent task is given to it by an orchestrator, which writes its prompt and sets its scope, so the kind of task is a stronger confounder for subagent tasks than for main-session ones, and a subagent starts without the main session's context. Read the subagent figures with that in mind. `--effort tools|all` (default `all`) chooses what counts as effort: `tools` counts the `Read`, `Grep`, `Glob`, `Edit`, `Write` and `NotebookEdit` tools only, and `all` also counts the files named in `Bash` commands as reads and edits ([suite](suite.md#measurement-across-the-suite) lists the commands read and the calls that are not parsed). The mode sets which tasks exist and the files each edited, so it sets distance as well as cost: a task that edited only through the shell has no edit under `tools` and is left out. The output gives `effort` (the mode) and `shell` (`calls`, `unparsed`, `parsedShare`) for all the tasks and for each source, and prints the same as a summary line on stderr when there were `Bash` calls. Only parsed calls count, and scripts that edit files by computed paths and reads made inside test runs and builds are not seen, so every figure is a lower bound and the parsed share says how much of the shell the figures could see. `measure baseline` takes the same `--source` and `--effort` and records them, and `measure compare` reads the source and mode the baseline recorded (a baseline recorded before shell commands were read counted `tools`) and refuses a conflicting `--source` or `--effort`. The result is an association over observed tasks, not a cause.

## Configuration

In the `locality` section of the suite config:

- Minimum distance guideline (`minDistance`).
- Size guidelines for tiny, medium and large (`tinyLines`, `largeLines`, `inlineHostLines`).
- High fan-in guideline for `scrutinise` (`highFanIn`).
- Grace period before a single callsite counts as evidence (`graceDays`).
- Co-change guidelines for the two- and three-consumer rules (`lowCoChange`, `highCoChange`) and the floor of changes they need (`minCoChangeChanges`).
- History-only support floor and confidence guideline (`historyMinSupport`, `historyMinConfidence`).
- Measure sample floor and noise guideline (`measureMinSamples`, `measureNoisePercent`).
- Fixed points and layer rules.
- Maximum nesting depth for targets.
- Shared history settings that the history-reading rules and `measure` use, from the top-level `history` section of the suite config ([suite.md](suite.md#configuration)), overridable here under the same names: `windowMonths`, `maxChangesetSize` and `botPatterns`.

The keys keep their names. [Guidelines and floors](#guidelines-and-floors) says which are guidelines and which are floors, and where each default comes from. Config comments and `locality explain` use the same words.

Entry points (including dynamic ones the parser cannot see) and exclusions live in the suite-wide part of the config. The history settings are the shared `history` section, and `locality.windowMonths` overrides its window.

## Decisions

These were open questions in the strawman. Each decision can be revisited with evidence.

- **First language: TypeScript/JavaScript**, then C#, then C++, then Python, Go, Java, Kotlin and Rust, all now supported (see [suite.md](suite.md#languages)). TypeScript has ts-morph for deterministic moves, and the suite itself is written in it. C# and C++ need symbol-based dependency resolution, and their moves touch namespaces or build files.
- **Tests do not decide targets.** Production consumers decide where code goes. Tests decide whether to inline (a unit with its own tests may be a deliberate seam), and owned tests move with their unit.
- **Default grace period: 90 days**, configurable.
- **High fan-in is an absolute guideline of 8 consumers**, reported with its ratio. It is not a percentile of the repository's fan-in. Each unit also prints `fanInPercentile`, the percentage of the repository's units whose fan-in is at or below its own, as information only: no recommendation, rule or sort reads it. CodeScene sets its hotspot cut-off from the slope of the change-frequency distribution, and a percentile or slope rule here would mark the top few units of every repository whatever their fan-in. The ratio lets a reader see how far past the guideline a unit is.
- **Size is measured in lines, not syntax nodes.** The tiny, large and host guidelines (15, 150 and 300 lines) pick a default remedy and are confirmed by the agent. `inlineHostLines` counts the consumer's lines plus the unit's lines.
- **Target selection.** The layout is preserved. Targets are the ancestors of the outer edge endpoints, no deeper than `maxDepth`. Ties go to the shallower folder, and the current folder wins a tie, so a move with no gain is never proposed. Equal-distance folders at the same depth give no target: the unit is omitted as `no single target: N folders tie`. Targets the placement rules of the move planner refuse are skipped before the gain is computed, so a candidate's `target` and `gain` are for the best folder that can be used. The rules are the planner's own (`placement.ts`): a file leaving its package (the nearest folder holding a manifest), a Go file crossing an `internal/` directory, a Go file landing in a package it imports or making two packages import each other, a Go file entering or leaving a `package main` folder, and a file landing on one that stays. When a folder with a larger gain exists but is refused, the candidate carries `unusableTarget` with that folder, its gain and the rule that refuses it.
- **Measures are heuristics.** No locality finding or measurement fails a command by itself. Findings carry the measured value and its guideline, and the skill describes them as worth a look or above guideline.
- **Transcript aggregation: local by default.** Only file paths and counts are extracted. Team aggregation is an explicit export of counts and repo-relative paths, never content.
- **History-only partners.** A co-change partner is a consumer when it shares at least `historyMinSupport` logical changes with the unit and at least `historyMinConfidence` percent of the unit's changes. Its weight in net distance is its shared changes times that confidence, on the same scale as reference counts. Units are single files, or clusters of files in one folder whose pairs each change together at least `highCoChange` percent of the time. Files that pull on each other are one question asked twice, so only the stronger pull is reported. Three or more partners that change together earn the distance and are left out, because this mode reports only `move` and `review`.
- **Baseline contents.** The baseline records what cannot be regenerated: the ranked candidates with the files of each and their consumers, the transcript tasks as paths and counts (Claude Code may delete the transcripts), and the repository's change spread. Group-level spread is recomputed from history over the baseline's window at comparison time, and `spreadReproduced` says whether history still gives the recorded figure.
- **Acted-on.** A baseline candidate is acted on when a commit after the baseline with a `Code-Health: locality` trailer renamed or removed one of its files. A candidate's neighbourhood is its unit and its consumers. The comparison group takes, for each acted-on candidate, the unused left-alone candidate of nearest baseline rank (ties to the better rank), skipping any that share a file with something acted on.
- **Matching windows.** The baseline window is the configured months back from HEAD's commit date, in whole UTC days. The after window has the same number of days, starts the day after the suite's last commit, and ends at HEAD if that comes first, which the output reports as incomplete. History and transcripts are cut at the same days, with the same filters.
- **What a comparison concludes.** Nothing from fewer than `measureMinSamples` tasks or changes in any of the four figures, and a difference within `measureNoisePercent` of the acted-on files' starting figure is no change. Effort fell when at least two of files read, folders visited, re-reads and tokens fell and none rose. A fall in spread without a fall in effort is reported as `spread-without-effort`, unproven.

## Open questions

- Whether `split` (symbols out of a mixed file) belongs in the deterministic mover, which ts-morph supports, or stays agent-performed.
- Whether to rename the plugin `cohesion`. The term is more widely recognised. `locality` names what the tool actually measures and changes.
- How to identify dynamic entry points (DI containers, plugin registries, framework file conventions) without per-framework config.

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
