# Co-change Tool — Spec

Part of the code-health suite. Read [suite.md](suite.md) first. It defines the plugin anatomy, CLI contract, config, cache and testing conventions that this spec assumes.

## Purpose

The tool mines version-control history to find where change effort concentrates and which files change together, so people and agents can see where the code makes change expensive. It ranks where to look. It never edits code.

Static analysis shows how code is built. History shows how it is actually changed. A file that is complex but untouched costs nothing. A complex file that changes every week is where effort goes. Two files that always change together but sit in different folders are a dependency the import graph may not show, and every change to one carries a hidden obligation to change the other. The second case matters most for agents, which work one file at a time and cannot recall what usually changes alongside.

## Scope

In scope:

- Ingesting git history into an incremental, rename-aware cache that the rest of the suite shares.
- Change frequency, churn and code age per file and per component.
- Hotspots: change frequency weighted by a complexity proxy.
- Temporal coupling: pairs and clusters of files that change together, with direction and strength.
- Change spread: how far apart the files touched by a single change are. This is the suite's primary outcome measure.
- Complexity trends of hotspot files over their history.
- Change-set completeness hints: telling an agent which files usually change with the one it is editing.
- Knowledge distribution and turnover-induced abandonment risk, off by default. It is a separate skill in this plugin, specified in [abandonment.md](abandonment.md).
- Risk of a branch before merge: its impact on the codebase and its author's placement to the code. Also a separate skill, specified in [change-risk.md](change-risk.md).

Out of scope:

- Code changes of any kind. Refactoring recommendations go to the locality and complexity plugins.
- Issue-tracker, CI or deployment data. A later extension could join defect data through commit-message conventions, but the core works from git alone.
- Individual developer performance metrics. The tool measures code, not people.

## Concepts

**Revision.** A commit that touches a file, after noise filtering.

**Logical change.** One or more commits that form a single unit of intent. By default each commit is its own logical change. Configurable grouping merges commits that share an issue key in the message (for example `ABC-123`) or come from the same author within a time window. Under issue-key grouping a key is reused over years and shares tokens with encodings and hashes (`UTF-8`, `SHA-256`), so commits join one change only within 90 days of the previous commit of the key, and those prefixes are not keys under the default pattern. Coupling is computed over logical changes, not raw commits, because a change split across three commits is still one change.

**Changeset size.** The number of files in a logical change after filtering. Logical changes above the configured maximum are excluded from coupling and spread, since bulk edits (formatting, licence headers, dependency bumps) couple everything to everything and carry no signal.

**Change frequency.** Revisions of a file within the analysis window.

**Churn.** Lines added plus lines deleted within the window, taken from `--numstat`.

**Complexity proxy.** Indentation complexity: the sum of logical indentation levels across a file's non-blank lines, leaving out comment lines where a lexer profile identifies them, with tabs and spaces normalised using the file's own detected indent unit. The definition is implemented once, in the shared `lexical` package, and the complexity plugin uses the same one. It is language-agnostic, needs no parser and can be computed for any historical blob cheaply. It correlates well with structural complexity measures and is enough for ranking. When a complexity report from the complexity plugin is present (see [Composition](#composition)), its file-level values are used instead and the output says which source was used.

**Hotspot score.** `normalise(changeFrequency) × normalise(complexity)`, where normalise is the rank percentile within the repository. Percentiles avoid the score being dominated by one outlier and keep it comparable across repositories.

**Temporal coupling.** Every count is in the same unit and over the same population: *eligible* logical changes, meaning those left after noise filtering and at or below the maximum changeset size. For files A and B, `n(A)` and `n(B)` are the eligible logical changes touching each, and `n(A∩B)` those touching both. Raw revision counts are not used here, because a change split over three commits, or a file swept up in an excluded bulk edit, would inflate the denominators and understate the coupling.

- *Degree*: `n(A∩B) / ((n(A) + n(B)) / 2)`, the symmetric strength, as a percentage.
- *Confidence A→B*: `n(A∩B) / n(A)`, the probability that a change to A also touches B. Directional, since a small file may always drag a large one along without the reverse holding.
- *Support*: `n(A∩B)`, the absolute count. It is an evidence floor (`minSupport`): `coupling` does not list a pair with fewer shared changes unless `--min-support` lowers the floor, and a pair listed under the configured floor is marked low confidence, because two shared commits out of three is too little evidence to separate coupling from chance.

**Coupling distance.** The folder-tree distance between the two files, using the suite's distance function (see [suite.md](suite.md#shared-vocabulary)). High coupling at high distance is the interesting case. High coupling between a file and its sibling test is expected.

**Change spread.** For a logical change touching files `F`, the mean pairwise tree distance between files in `F`. A single-file change has spread 0. Each file is placed at its path as of that change, not its current path, so moving files later does not lower the spread of changes made before the move. Reported as a distribution over a time window: median, p75, p90, with the number and share of logical changes left out for exceeding the maximum changeset size. Those are the widest changes of all, so a shift in that share is part of the result.

**Code age.** Time from a file's last revision to HEAD's commit date. Recently changed code is likely to change again. Stable code is cheap to move and costly to rewrite.

## Architecture

The deterministic CLI does all mining and scoring. The skill decides which question to ask and what the answer means.

- **History core** (shared package, bundled into every plugin that needs history): runs `git log`, parses it, maintains the cache. Locality and complexity bundle the same code, so any of them can refresh the cache.
- **CLI** `cochange` with subcommands below. Every subcommand supports `--json` with a versioned schema.
- **Skill** `cochange` holding the investigation playbooks: hotspot review, coupling review, pre-change briefing, and measuring an outcome.
- **Skill** `abandonment`: knowledge-loss risk from Monte Carlo turnover simulation, and successor recommendations ([abandonment.md](abandonment.md)).
- **Skill** `identities`: an agent-reviewed `.mailmap` merging each person's names and emails and marking bots, which any analysis that counts people relies on ([identities.md](identities.md)).
- **Skill** `change-risk`: the impact of a branch and its author's placement to the code it touches, with a recommended review response ([change-risk.md](change-risk.md)).
- **Hook** (opt-in): change-set completeness hints after edits.

There is no parser dependency. This plugin ships no tree-sitter grammars and stays small.

## History ingestion

The ingestion must be correct before anything built on it can be trusted, so it is specified closely.

- Read with `git log --no-merges --numstat -M -z --format=<fixed>` (plus `--first-parent` when enabled) from the analysed ref: HEAD by default, or the configured branch. The rename similarity and rename limit are passed on the command line, so the user's git config cannot change the result, and the git version is recorded in `meta`. First-parent is configurable. It defaults to off for trunk-based repos and on for repos that merge long-lived feature branches, where it avoids double-counting.
- Rename detection is on (`-M`, configurable similarity). Renames are recorded in a rename table, and every query resolves a path through it to a stable file identity, so moved files keep their history. This matters for this suite in particular, because the locality plugin moves files and its success is measured through this history.
- Binary files (numstat `-`) are recorded as changed with no line counts.
- Incremental: commits are stored by SHA and never invalidated ([suite.md](suite.md#shared-caches)). A refresh reads the commits reachable from the analysed ref that are not yet stored, and queries select by reachability. A rewritten history or a branch switch adds the new commits and leaves the rest, so there is no rebuild.
- Shallow clones are detected. The tool reports the truncated window instead of silently analysing partial history. CI usage needs `fetch-depth: 0` or an explicit window.
- Author identity respects `.mailmap`, which the [identities](identities.md) skill builds and reviews.

### Noise filters

Applied at query time, not ingestion, so changing config never needs a rebuild:

- Paths excluded by the suite's shared `exclude` globs, `.gitattributes` `linguist-generated` / `linguist-vendored`, and lockfiles by default.
- Commits listed in `.git-blame-ignore-revs` (formatting sweeps).
- Authors classified as bots or service accounts by the identities configuration and decisions ([identities.md](identities.md#non-person-classification)).
- Logical changes above the maximum changeset size (default 30 files) are excluded from coupling and spread, but still count towards change frequency. Coupling's own counts leave them out on both sides of the ratio, and spread reports how many were excluded.
- Pure renames (100 % similarity, no content change) count neither as revisions nor as coupling.

## CLI

| Command | Output |
|---|---|
| `cochange refresh` | Updates the cache. Reports commits added. |
| `cochange hotspots [--by file\|component] [--limit N]` | Ranked hotspots with frequency, churn, complexity, age, and score. |
| `cochange coupling [--file PATH] [--min-degree D] [--min-support S]` | Coupled pairs with degree, confidence in both directions, support and distance. The degree (`minDegree`, `--min-degree`) is a guideline: pairs under it are listed after the others with `aboveGuideline` false, and none is left out for its degree. The support floor (`minSupport`, `--min-support`) is the only cut. With `--file`, the files that change with that one. |
| `cochange clusters [--min-degree D] [--min-support S]` | Groups of mutually coupled files, with their spread. A pair joins a group when it reaches both the support floor and the degree: this is the one place `minDegree` is a cut, because a group has to be defined by its links. Candidates for co-location. |
| `cochange spread [--since DATE] [--until DATE] [--bucket week\|month]` | Change-spread distribution per bucket. Used for baselines and outcome comparison. |
| `cochange age [--by file\|component]` | Last-changed and first-seen per file. |
| `cochange trend PATH [--samples N]` | Complexity proxy and size of one file sampled across its history, to show whether a hotspot is getting worse. |
| `cochange outcome spread --at DATE PATH... [--months N]`, `cochange outcome completeness --since DATE --until DATE [--projects-dir DIR]` | The change-spread outcome against matched untouched files, and the agent completeness outcome from session transcripts with and without the hook. See [Measurement](#measurement). |
| `cochange brief PATH...` | A compact pre-change briefing: files usually changed alongside, recent activity, whether the file is a hotspot. Built for agents. |
| `cochange blame refresh`, `cochange abandonment …`, `cochange successors` | Knowledge-loss analysis. Only when enabled. See [abandonment.md](abandonment.md#cli). |
| `cochange risk …` | Risk of a branch against its base. See [change-risk.md](change-risk.md#cli). |

Every list output is sorted by score, then by path, so ties are deterministic, and is limited by default (20). The JSON includes `window`, `filtersApplied`, `complexitySource` and the suite's `evidence` block ([suite.md](suite.md#evidence-strength)), so a reader always knows what was measured and how much to trust it. Mature codebases give this plugin its strongest results. On a young repository, `coupling` and `clusters` may return few pairs that reach the support floor, and they say so rather than lowering the floor.

## Recommendations

The tool classifies findings, and the skill turns the classifications into actions. Classifications are deterministic.

| Finding | Condition | Suggested handoff |
|---|---|---|
| `hotspot` | Score in the top configured percentile and changed within the recent window | Complexity review of the file's worst functions |
| `distant-coupling` | Degree ≥ guideline, support ≥ minimum, distance ≥ minimum | Locality review: should these live together? Otherwise check for *information leakage*, where one design decision is encoded in both files. |
| `change-magnet` | A file that co-changes with many folders, which rarely co-change with each other (a star shape) | Likely a registration hub. See [structure](structure.md#concepts) for confirmation and the inversion remedy. |
| `asymmetric-coupling` | Confidence A→B high, B→A low | A depends on B implicitly. Check for *information leakage* or *temporal decomposition* (code split by when it runs rather than by what it knows). |
| `cluster` | Coupled component spanning ≥ 3 folders | Candidate for co-location or a module boundary |
| `cold` | Not changed within the stale window | Lowest priority for refactoring; cheapest to move |
| `test-drift` | A source file with high frequency whose sibling test never co-changes | Behaviour may be changing without tests following |

This plugin has no parser, so it cannot tell whether a coupled pair also has a static dependency. *Hidden coupling* (co-change with no static dependency) is therefore classified by [structure](structure.md#concepts), from this plugin's coupling data.

These are prompts for investigation, not verdicts. The skill reviews each finding against the suite's design red flags ([red-flags.md](../../shared/red-flags.md)). Co-change is the strongest evidence the suite has for *information leakage* and *conjoined methods*, two red flags that static analysis cannot see. The skill records why a finding was acted on or dismissed.

## Agent integration

### Pre-change briefing

The skill instructs the agent to run `cochange brief` on the files it plans to change before starting a non-trivial task. The briefing names the files that usually change alongside, so the agent opens them deliberately instead of discovering them after tests fail.

### Change-set completeness hook (opt-in)

A `PostToolUse` hook on `Edit`, `Write` and `MultiEdit` looks up the edited file in the cache (read-only, no refresh, with a time budget of 200 ms) and, when there are coupled files at or above the confidence guideline (`cochange.hook.confidence`, default 80 %) that have not been edited in this session (from the hook's own session state, [suite.md](suite.md#hooks)), injects a short note. The note states each partner's measured confidence and support and the guideline, and suggests looking. It states no rule:

> `src/billing/invoice.ts` changed together with `src/reports/invoice-summary.ts` (confidence 82 %, 17 changes). Guideline: confidence 80 %. Not yet edited in this session, so worth a look.

Rules for the hook:

- Prints nothing when the cache is missing, or more than the configured number of commits behind HEAD (default 50). Coupling evidence barely moves over a few commits, and a hook that printed nothing after every commit or pull would rarely print a note. It never triggers a refresh, never blocks the edit, and never fails loudly.
- Names at most `cochange.hook.maxPartners` partners (default 3), strongest first, and says how many more qualified.
- At most one note per file per session, because repeating a note adds tokens and no information.
- Off by default and enabled per repository in config, because injected context has a token cost.

## Composition

The plugin is self-contained. It reads reports produced by sibling plugins when they exist, and never requires them:

- Writes its latest results to `.cache/code-health/reports/cochange.<command>.json`.
- Reads `.cache/code-health/reports/complexity.files.json` when it is present and stamped with the current HEAD, and uses it as the complexity source for hotspots. The output names it in `inputs`.
- The locality plugin reads coupling and spread from the shared cache directly, using the same bundled history core.

## Measurement

This plugin supplies the suite's primary outcome measure, change spread. Its own success is whether teams act on hotspots and couplings in ways that make later changes cheaper:

| Measure | What it shows | Role |
|---|---|---|
| Change spread on files in acted-on findings, before and after, against similarly ranked findings left alone ([suite.md](suite.md#measurement-across-the-suite)) | Changes became more local | Primary outcome |
| Revisions per hotspot over a matching window | Effort concentration decreased | Secondary outcome |
| Hotspot score of acted-on files | The file got simpler or less churned | Leading indicator only |
| Agent edits followed by a coupled file being edited later in the same session, with and without the hook | The briefing and hook prevented missed changes | Agent outcome |

`outcome spread` takes the files acted on and a date. The comparison group is the untouched file of nearest rank for each, ranked by revisions in the before window, since a hotspot score exists only at the analysed commit, and files that changed together with an acted-on file are passed over. `outcome completeness` reads session transcripts for the edits of each session in order, counts a file's first edit as an opportunity when a coupled partner the hook would name is not yet edited, and counts it followed when one is edited later in the session. Sessions are with the hook when it left session state for them. The two arms are not randomised, so the difference is reported as an association. Both read only paths and counts, and neither writes a report.

## Privacy

- Nothing leaves the machine. There is no network access and no telemetry.
- Default outputs contain no author identities. Change counts are aggregated per file.
- The `identities` commands necessarily show names and emails. They show only what `git log` already shows, run only through the identities skill or on an explicit request, and never write to `reports/`, so no other plugin can pick identities up ([identities.md](identities.md#privacy)).
- Knowledge and abandonment analysis is disabled unless config enables it, and has stricter rules of its own ([abandonment.md](abandonment.md#privacy)). The skills must not use history data to judge individuals and should say so if asked to.

## Configuration

In the `cochange` section of the suite config:

- Shared history settings, read from the top-level `history` section of the suite config ([suite.md](suite.md#configuration)) and overridable here under the same names: `branch`, `firstParent`, `renameSimilarity`, `renameLimit`, `windowMonths` (default 12 months), `maxChangesetSize`, `botPatterns`, `fixPatterns`, `revertPatterns`, `fixMatchBody` and `evidence`. The last three define a fix commit for change-risk (see [suite.md](suite.md#configuration)): `cochange.risk.fixPatterns` and `cochange.risk.revertPatterns` were removed in favour of `history.fixPatterns` and `history.revertPatterns`.
- Recent window (default 3 months) and stale window.
- Logical change grouping: off, by issue-key pattern, or by author and time window.
- Minimum support, minimum degree, minimum coupling distance.
- Hook enablement, confidence guideline and staleness tolerance.
- Identity settings, including service patterns, under `cochange.identities` ([identities.md](identities.md#configuration)).
- Knowledge analysis settings under `cochange.knowledge` ([abandonment.md](abandonment.md#configuration)).
- Change risk settings under `cochange.risk` ([change-risk.md](change-risk.md#configuration)).

## Decisions

- **Indentation complexity as the default proxy.** It keeps the plugin parser-free and makes `trend` cheap over hundreds of historical blobs. A precise complexity report is used when available.
- **Percentile normalisation.** Absolute scores are not comparable across repositories, and raw multiplication lets one huge file dominate.
- **Query-time filtering.** Config changes should give new answers immediately, without rebuilding the cache.
- **Coupling over logical changes.** Commit granularity varies by person. Grouping is opt-in because the wrong grouping invents coupling.

## Open questions

- Whether to weight recent changes more heavily (exponential decay) or keep a flat window. A flat window is simpler to explain. Decay ranks current hotspots better.
- Whether coupling should also be computed at symbol level by mapping diff hunks to function ranges with tree-sitter. It is more precise but would bring the parser into this plugin. It could instead be a feature of the complexity plugin, which already parses.
- The default for first-parent mode when the merge style cannot be detected.

## Milestones

1. History core: ingestion keyed by commit, rename map, incremental refresh, reachability queries across branch switches and rewrites, noise filters, with fixture-repo tests.
2. `hotspots`, `age` and `coupling` with JSON schemas.
3. `spread` with bucketing, ready to baseline locality work.
4. Skill playbooks and plugin packaging.
5. `brief` and the opt-in completeness hook.
6. `clusters`, `trend` and complexity-report composition.
7. Logical change grouping.
8. Abandonment skill, following its own milestones.
9. Change risk skill, following its own milestones.
