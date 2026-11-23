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
- Fix counts per file and component, from commit messages under the suite's shared fix definition ([suite.md](suite.md#configuration)).
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

**Fix.** A change that landed on the main line, under the single definition in the shared history package that change-risk and the complexity outcome also use (see [suite.md](suite.md#configuration)). A landed change is a commit on the first-parent line, or a merge commit together with the commits that only its later parents reach, and it is classified by its own text: the message of a squash or direct commit, the pull request title of a merge (parsed from the body of "Merge pull request #N from owner/branch", from the subject of "Merge pull request #N: title", and from the line after the blank one in GitLab's "Merge branch 'x' into 'main'"). It is a fix when that text matches `history.fixPatterns`, and a revert, counted apart and never as a fix, when it matches `history.revertPatterns` or says `This reverts commit`. A fix made on a branch before it merged was caught in review and is not a regression: those commits are counted apart as **fixes during review** (`reviewFixes`, with their commits as evidence) and never as fixes. A landed change is counted once per file or component it touches, and that includes a change that creates the file. `complexity fixes` does not count the creation of a file as a fix of its functions, so a file created by a fix has one fix here and none in a function row there. A count of fixes is a count of commit messages, not of defects: the default patterns match fix words at the start of the subject or after "to", and the whole words `bug`, `bugfix`, `hotfix` and `defect` anywhere, so `fix the bug report template` is a match, and a fix that does not say so is missed. A landed change that a fix pattern matched and `history.fixExcludePatterns` removed (it has a non-fix Conventional Commits type, or its fix target is typos, spelling, lint or formatting) is not a fix: `cochange fixes` counts these as `fixesExcluded`, by the excluding pattern, and prints a notice. The change behind each count is listed as evidence. Hotspots `frequency` and `fixes` `revisions` count every commit that touched the file. The share of fixes is over `landedChanges`, the landed changes that touched it, so it compares like with like.

**Hotspot score.** `normalise(changeFrequency) × normalise(complexity)`, where normalise is the rank percentile within the repository. Percentiles avoid the score being dominated by one outlier and keep it comparable across repositories.

**Temporal coupling.** Every count is in the same unit and over the same population: *eligible* logical changes, meaning those left after noise filtering and at or below the maximum changeset size. For files A and B, `n(A)` and `n(B)` are the eligible logical changes touching each, and `n(A∩B)` those touching both. Raw revision counts are not used here, because a change split over three commits, or a file swept up in an excluded bulk edit, would inflate the denominators and understate the coupling.

- *Degree*: `n(A∩B) / ((n(A) + n(B)) / 2)`, the symmetric strength, as a percentage.
- *Confidence A→B*: `n(A∩B) / n(A)`, the probability that a change to A also touches B. Directional, since a small file may always drag a large one along without the reverse holding.
- *Support*: `n(A∩B)`, the absolute count. It is an evidence floor (`minSupport`): `coupling` does not list a pair with fewer shared changes unless `--min-support` lowers the floor, and a pair listed under the configured floor is marked low confidence, because two shared commits out of three is too little evidence to separate coupling from chance.

**Coupling trend.** `coupling --trend` compares each pair with the window before the current one: a window of the same length that ends where the current one starts, read with the same filters and counted over its own eligible changes. For each pair it gives the degree and support in both windows, the change in degree in percentage points, and a label: `stronger`, `weaker`, or `stable` when the degree moved by at most `couplingTrendTolerance` points either way (default 10, a judgement call, so the degrees are always printed beside the label). Degrees are compared rounded to one decimal, so the label agrees with what is printed. A pair that shared no change before has degree 0 and support 0 there and counts as stronger; the previous support says so. When the previous window holds no eligible change, the trend is null and the output says so. The previous window is read without a support floor, so a pair that was weak before has its real earlier degree. A shallow clone may hold less of the previous window than the current one.

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

- Paths excluded by the suite's shared `exclude` globs, generated and vendored files (suite spec, "Generated and vendored files"), and lockfiles by default. `hotspots`, `fixes` and `age` rank code only unless `--all-files` is given, and `coupling` labels each file of a pair as code or non-code (suite spec, "Code and non-code files").
- Commits listed in `.git-blame-ignore-revs` (formatting sweeps).
- Authors classified as bots or service accounts by the identities configuration and decisions ([identities.md](identities.md#non-person-classification)).
- Logical changes above the maximum changeset size (default 30 files) are excluded from coupling and spread, but still count towards change frequency. Coupling's own counts leave them out on both sides of the ratio, and spread reports how many were excluded.
- Pure renames (100 % similarity, no content change) count neither as revisions nor as coupling.

## CLI

| Command | Output |
|---|---|
| `cochange refresh` | Updates the cache. Reports commits added. Takes no arguments: a stray word is a usage error. |
| `cochange hotspots [--by file\|component] [--all-files] [--include-tests] [--limit N]` | Ranked hotspots (production code files, or all with `--all-files`; the test files, by the language conventions and the shared `testPatterns`, are left out and counted in `dropped.tests` unless `--include-tests` lists them with a `role`, and the percentiles are taken among the files listed) with frequency, churn, complexity, age, score, and `landedChanges`, `fixes`, `fixShare` (fixes over `landedChanges`) and `reviewFixes` with a few `reviewFixEvidence` commits, counted as `fixes` counts them. The output carries `fixConvention`. |
| `cochange coupling [--file PATH] [--min-degree D] [--min-support S] [--trend]` | Coupled pairs, each side labelled `code` or `non-code` (`pathKind`, `withKind`), with degree, confidence in both directions, support and distance. The degree (`minDegree`, `--min-degree`) is a guideline: pairs under it are listed after the others with `aboveGuideline` false, and none is left out for its degree. The support floor (`minSupport`, `--min-support`) is the only cut. With `--file`, the files that change with that one. With `--trend`, each row also has `previousDegree`, `previousSupport`, `degreeChange` and `trend` (see Coupling trend). |
| `cochange clusters [--min-degree D] [--min-support S]` | Groups of mutually coupled files, with their spread. A pair joins a group when it reaches both the support floor and the degree: this is the one place `minDegree` is a cut, because a group has to be defined by its links. Candidates for co-location. |
| `cochange report <kind> [--slots \| --notes FILE --format html\|md [--out PATH]]` | Renders a page from the CLI's data and the agent's judgement slots, as [Reports](suite.md#reports) defines. `overview` shows the evidence, the fix convention check, what was excluded and the top 5 of each plugin's stored main result. `hotspots [--top N]` shows a treemap, the friction list (files in the top percentile of both change frequency and complexity, with their history and an X-Ray read from the complexity plugin's stored results); `coupling`, `knowledge` (needs `knowledge.enabled`) and `change [BASE[..HEAD]]` (the change summary, with `--evidence FILE` for complexity and structure results) are the other reports this plugin owns. |
| `cochange spread [--since DATE] [--until DATE] [--bucket week\|month]` | Change-spread distribution per bucket. Used for baselines and outcome comparison. |
| `cochange fixes [--by file\|component] [--all-files] [--evidence N]` | Code files (all files with `--all-files`) or components sorted by fix count, then path. Per row: `fixes` (landed changes that are fixes by their own title), `revisions` (every commit that touched it, as hotspots counts them), `landedChanges`, `fixShare` (fixes over `landedChanges`), `recentFixes` (inside `cochange.recentMonths`), `lastFix`, `reverts` (a separate column, never counted as fixes), `evidence`, the matching changes newest first (`sha`, `date`, `subject`, the pattern that matched) up to `--evidence` (default 5) with `omitted` counting the rest, and `reviewFixes` with `reviewEvidence`, the fix-like commits made on a branch before it merged, listed apart and never counted in `fixes`. The output carries `fixesDuringReview`, those commits over the whole window, with the same evidence shape as `fixesExcluded`. It counts as `hotspots` does: same window, noise filters, rename following and bot exclusion. The output carries `fixConvention`, the repository-level check on the fix definition: whether the landed titles use a recognisable fix form (Conventional Commits types, a leading Fix or Fixes, issue references), with the form counts and the share of fixes beside the verdict. The table prints a `Notice` when no form is seen. Every file is still listed and the counts are still printed. |
| `cochange age [--by file\|component] [--all-files]` | Last-changed and first-seen per file. |
| `cochange trend PATH [--samples N]` | Complexity proxy and size of one file sampled across its history, to show whether a hotspot is getting worse. |
| `cochange outcome spread --at DATE PATH... [--months N]`, `cochange outcome completeness --since DATE --until DATE [--projects-dir DIR]` | The change-spread outcome against matched untouched files, and the agent completeness outcome from session transcripts. See [Measurement](#measurement). |
| `cochange brief PATH...` | A compact pre-change briefing: files usually changed alongside, recent activity, fix count and share for each file, whether the file is a hotspot. Built for agents. |
| `cochange blame refresh`, `cochange abandonment …`, `cochange successors` | Knowledge-loss analysis. Only when enabled. See [abandonment.md](abandonment.md#cli). |
| `cochange risk …` | Risk of a branch against its base. See [change-risk.md](change-risk.md#cli). |

Every list output is sorted by score, then by path, so ties are deterministic (`coupling` breaks a tie in degree by shared changes, highest first, before the path), and is limited by default (20). The JSON includes `window`, `filtersApplied`, `complexitySource` and the suite's `evidence` block ([suite.md](suite.md#evidence-strength)), so a reader always knows what was measured and how much to trust it. Mature codebases give this plugin its strongest results. On a young repository, `coupling` and `clusters` may return few pairs that reach the support floor, and they say so rather than lowering the floor.

**Coupling report.** `cochange report coupling` judges only pairs of production files. A pair is an *expected pair* when either file is a test (naming convention or the shared `testPatterns`), when either file is a fixture or golden file (a `testdata`, `fixtures`, `goldens`, `__snapshots__` or `snapshots` folder, or a `.golden`, `.snap`, `.approved` or `.received` name), when the files are a C or C++ header and its source file with the same path apart from the extension (`Foo.h` and `Foo.cpp`), when both files are build or packaging manifests of one toolchain (`go.mod`, `go.sum` and `go.work`; a `Dockerfile` and its variants; `package.json` and its lockfiles; `CMakeLists.txt` and `*.cmake`; `*.csproj`, `*.sln` and `Directory.*.props`; Cargo, Gradle, Maven, Python and Ruby manifests; Makefiles), or when both files are non-code files of one format (two workflow files, two scene files). When the 5 judged pairs end inside a run of pairs that tie on degree and shared changes, a notice says which pairs tie ("Pairs 3 to 9 tie on degree and shared changes; the order among them is by path") and that the judged pairs are the first by path, not the strongest. Expected pairs are listed in their own table, capped at 10, with the reason and a count by reason; none is dropped, and `cochange coupling` prints every pair. Fewer than 5 pairs at the support floor is thin data: the report prints the count and the floor, how many pairs share between two fewer and one fewer than the floor, and those pairs as a capped list that gets no judgement slot. The floor is never lowered. With no eligible change in the previous window the trend column is omitted and one line says so.

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

## Maintainer commands

`cochange risk backtest` ([change-risk.md](change-risk.md#maintainer-commands)) and `cochange abandonment backtest` ([abandonment.md](abandonment.md#maintainer-commands)) are calibration tools run by the suite's maintainers. They are left out of `--help` listings and of the skills.

## Composition

The plugin is self-contained. It reads reports produced by sibling plugins when they exist, and never requires them:

- Stores its results on demand in `.cache/code-health/reports/cochange.<command>[.<variant>].json`, and prints a stored result when its commit, config and inputs match (see [suite.md](suite.md#shared-caches)). `hotspots`, `coupling` and `brief` do this, and `--no-cache` computes again. `brief` is computed from the stored hotspot ranking, coupling pairs and per-file activity, so a briefing reads no history when those are stored.
- Reads `.cache/code-health/reports/complexity.files.json` when it is present and stamped with the current HEAD, and uses it as the complexity source for hotspots. The output names it in `inputs`.
- The locality plugin reads coupling and spread from the shared cache directly, using the same bundled history core.

## Measurement

This plugin supplies the suite's primary outcome measure, change spread. Its own success is whether teams act on hotspots and couplings in ways that make later changes cheaper:

| Measure | What it shows | Role |
|---|---|---|
| Change spread on files in acted-on findings, before and after, against similarly ranked findings left alone ([suite.md](suite.md#measurement-across-the-suite)) | Changes became more local | Primary outcome |
| Revisions per hotspot over a matching window | Effort concentration decreased | Secondary outcome |
| Hotspot score of acted-on files | The file got simpler or less churned | Leading indicator only |
| Agent edits followed by a coupled file being edited later in the same session | How often agents complete a change set, a baseline to compare a later period against | Agent outcome |

`outcome spread` takes the files acted on and a date. The comparison group is the untouched file of nearest rank for each, ranked by revisions in the before window, since a hotspot score exists only at the analysed commit, and files that changed together with an acted-on file are passed over. `outcome completeness` reads session transcripts for the edits of each session in order, counts a file's first edit as an opportunity when a coupled partner is not yet edited, and counts it followed when one is edited later in the session. A partner is a file that shares at least `minSupport` changes with it, reaches the degree guideline (`minDegree`) and still exists, from the changes committed before the session began. It reports the opportunities, the number followed and the rate, and the sessions measured, and gives a null rate when there are no opportunities. The rate depends on the work, the period and the people, so it is a baseline to compare a later window against and not the effect of any change. It reads only paths and counts, and neither it nor `outcome spread` writes a report.

## Privacy

- Nothing leaves the machine. There is no network access and no telemetry.
- Default outputs contain no author identities. Change counts are aggregated per file.
- The `identities` commands necessarily show names and emails. They show only what `git log` already shows, run only through the identities skill or on an explicit request, and never write to `reports/`, so no other plugin can pick identities up ([identities.md](identities.md#privacy)).
- Knowledge and abandonment analysis is disabled unless config enables it, and has stricter rules of its own ([abandonment.md](abandonment.md#privacy)). The skills must not use history data to judge individuals and should say so if asked to.

## Configuration

In the `cochange` section of the suite config:

- Shared history settings, read from the top-level `history` section of the suite config ([suite.md](suite.md#configuration)) and overridable here under the same names: `branch`, `firstParent`, `renameSimilarity`, `renameLimit`, `windowMonths` (default 12 months), `maxChangesetSize`, `botPatterns`, `fixPatterns`, `revertPatterns`, `fixMatchBody` and `evidence`. The last three define a fix commit for change-risk (see [suite.md](suite.md#configuration)): `cochange.risk.fixPatterns` and `cochange.risk.revertPatterns` were removed in favour of `history.fixPatterns` and `history.revertPatterns`.
- Recent window (default 3 months) and stale window.
- `hotspotPercentile` (default 90): the percentile of change frequency (and, without a stored `complexity analyse` result, of complexity) at which a file is on the hotspots report's friction list. `hotspotJudged` (default 10): how many friction files the report asks a judgement of. It is a guideline for the length of the page (each file costs two slots), taken from nothing measured, and it changes no ranking; the rest of the list is in the table.
- Logical change grouping: off, by issue-key pattern, or by author and time window.
- Minimum support, minimum degree, minimum coupling distance, and the coupling trend tolerance (`couplingTrendTolerance`, default 10 percentage points).
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
5. `brief`.
6. `clusters`, `trend` and complexity-report composition.
7. Logical change grouping.
8. Abandonment skill, following its own milestones.
9. Change risk skill, following its own milestones.
