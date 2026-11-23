# Abandonment Risk Skill — Spec

A second skill in the **cochange** plugin. Read [suite.md](suite.md) and [cochange.md](cochange.md) first. This skill reuses cochange's history cache, identity handling and coupling.

## Purpose

The skill estimates how much of the codebase's knowledge would be lost when people leave, shows where that risk concentrates in code that matters, and recommends who should pick up knowledge before it is lost. It treats turnover as a risk to model across many scenarios, not as a single "bus factor" number.

Code nobody left on the team has written is costlier to change. Its authors' assumptions are gone, reviewers lack context, and agents get no help from people who remember why it is the way it is. Turnover is normal, so the question is not *whether* knowledge will be lost but *how much, where, and with what tail risk*.

## Basis

The method follows Rigby, Zhu, Donadelli and Mockus, *Quantifying and Mitigating Turnover-Induced Knowledge Loss: Case Studies of Chrome and a Project at Avaya* (ICSE 2016):

- A line is **abandoned** when its last author has left. A file is **abandoned** when at least 90 % of its lines are abandoned.
- **Monte Carlo simulation** of turnover scenarios produces a distribution of knowledge loss rather than a point estimate.
- Risk is expressed with financial measures. **Knowledge at risk** (KaR) is the α percentile of the loss distribution, analogous to value at risk. The paper found losses more than three times the expected loss in the tail, and more than five times under historical simulation. Simple truck-factor estimates exaggerated the potential for loss.
- **Successors** are recommended from coordination requirements (Cataldo et al.): people who work on related files. The paper recommended the right successor 34–48 % of the time, and having successors reduced expected loss by up to 15 %.
- Most abandoned files were adopted by existing experts, not newcomers.

The paper's guidelines are defaults here, and every one is configurable.

## Scope

In scope:

- Line-level authorship at HEAD, cached incrementally.
- Current abandonment: files with lines held by people who have left, ranked by score, with the files at the abandonment guideline marked abandoned.
- Simulated abandonment: loss distribution, expected loss, KaR and tail ratio, per file and per component.
- Risk weighted by importance: abandonment probability combined with hotspot score, so cold code ranks below code that changes.
- Successor recommendations for at-risk files.
- Maintainer commands that calibrate the model against a repository's own history, which are not for end users (see [Maintainer commands](#maintainer-commands)).

Out of scope:

- Predicting which individuals will leave. The simulation samples departures at random from a rate. It never models or ranks a person's likelihood of leaving.
- Judging individuals' contribution or performance.
- HR or organisational data. Activity is inferred from git only, with optional local overrides.

## Concepts

**Author of a line.** The commit that last introduced the line at HEAD, from `git blame -w -M -C --line-porcelain`, ignoring revisions in `.git-blame-ignore-revs`. `-M -C` make moved and copied lines keep their original author, so the locality plugin's move commits do not reset authorship. Formatting sweeps are covered by `-w` and the ignore-revs file. The blame cache stores the commit behind each line range, per blob. Identities, activity and overrides are resolved at query time, so a change to the mailmap never needs a re-blame. The first run blames every file and is the slow step on a large repository, `-C` most of all. It reports progress, can be resumed, and `-C` can be turned off in config.

**Developer identity.** Resolved through a reviewed `.mailmap`, built with the [identities](identities.md) skill. Bot and service authors (from the identities classification) are excluded from the population, and their lines count as owned by nobody. Those lines are left out of both sides of a file's abandoned share, and are reported separately rather than treated as abandoned.

**Notices.** Every subcommand but `backtest` prints results in full and adds a `notices` list to the document (and `Notice:` lines in a table) when there is something to say about how far to trust them. The results are never withheld by these guidelines:

- Settled identities hold less than `mappedShareGuideline` of the lines held by people, with the measured share (the `identities check` figure). One person under several identities counts as several people, so who has left, and what leaving costs, is overstated.
- `simulate` and `trend` take the leaver probability from history, and fewer than `minTurnoverPeriods` periods were observed. The notice gives the number of periods.
- `turnoverRate` is below one percent: it is a percentage, so 0.3 is 0.3 percent, and 30 means 30 percent.

**Active developer.** A developer with at least one commit in the activity window (default 6 months). Inactive developers are treated as having left. That is a proxy: people on leave or moved to another repo look inactive. A local overrides file corrects it (see [Privacy](#privacy)).

**Departure.** A developer has left, as of their last commit, when no further commit follows within the activity window. This is the same test as *active*, so someone who commits every few months stays active throughout and never counts as a leaver in a period with few commits. Departures in the most recent activity window cannot be known yet, so those periods are left out of rate estimation.

**Turnover rate.** Per period (default quarter): the developers whose departure falls in that period, over the developers active at its start. It is estimated from history, or set explicitly in config.

**Loss.** For a scenario with leaver set *L*, the number of lines (and files) abandoned once *L* and all already-inactive developers are removed. Reported as lines, files and the share of the codebase, both in total and as the increment over what is already abandoned at HEAD, since only the increment can still be prevented.

**Abandonment probability.** For one file, the fraction of trials in which it ends up abandoned.

**Coordination successor.** For a file *f* at risk, an active developer ranked by how much they have changed files that co-change with *f* (cochange coupling weights), plus their own lines in *f*.

## Simulation

All simulation is deterministic. A seeded PRNG is used, with the seed in config and in the output, so the same repo, config and seed give byte-identical results.

Modes:

| Mode | Leaver selection per trial | Use |
|---|---|---|
| `rate` (default) | Each active developer leaves independently with probability *p* over the horizon: `p = 1 − (1 − q)^h` for a per-period turnover rate *q*, estimated or configured, and a horizon of *h* periods | Expected exposure under normal turnover |
| `historical` | Sample *h* of the repository's own past per-period rates with replacement (bootstrap), compound them into *p*, then apply as in `rate` | Exposure including bad quarters. The paper found it gives fatter tails. |
| `k-leavers` | Exactly *k* active developers, sampled uniformly | Stress test. It replaces the truck factor with a distribution. |

Defaults: 10,000 trials, a one-year horizon, and α = 0.95 and 0.99.

Per trial, compute abandoned lines and files at HEAD. Across trials, report:

- **Expected loss** (mean).
- **KaR at each α** (percentile).
- **Tail ratio**: KaR / expected loss. A high ratio means knowledge is concentrated.
- **Expected tail loss**: the mean of losses beyond KaR. It is an extension to the paper that shows how bad the tail is, not just where it starts.
- Per file: abandonment probability, and its contribution to tail scenarios.

Trials only need, per file, the set of developers with lines in it and their line counts. Precomputing that makes each trial a pass over files, not over lines, so 10,000 trials on a large repository take seconds.

## Ranking

Raw abandonment ranks old, stable, rarely touched code highest. That is real risk, but rarely urgent. Files are ranked by **abandonment probability × hotspot percentile** by default (from cochange), so knowledge about code that keeps changing comes first. `--rank abandonment` gives the raw view.

Findings:

| Finding | Condition | Suggested mitigation |
|---|---|---|
| `abandoned` | Already ≥ guideline abandoned at HEAD | Adoption: assign the top successor; prioritise if it is also a hotspot |
| `at-risk-hot` | High abandonment probability and hotspot | Knowledge transfer now: pairing, reviews by successors, a walkthrough |
| `at-risk-cold` | High abandonment probability, rarely changed | Lightweight capture: a short design note, characterisation tests |
| `concentrated-component` | Component with a high tail ratio | Rotate reviewers within the component |
| `no-successor` | At-risk file with no active developer touching coupled files | Escalate. Nobody is near this code. |

## Knowledge-risk patterns

`cochange abandonment patterns` labels every file that has a blame with the named shapes of who holds its lines, in the style of CodeScene's knowledge risks. A pattern is a label for investigation. Each has a stated guideline that is configurable and reported beside the numbers, and no file is left out of the listing for lacking a pattern: a file with none has `pattern: null`.

| Pattern | Applies when | Suggested mitigation |
|---|---|---|
| `single-owner-hotspot` | One active developer holds at least `singleOwnerShare` of the lines held by people, and the file is a hotspot (as `cochange hotspots` defines it) | Pair on the next change, and have another active developer review each change |
| `former-contributors-complex` | Developers who have left hold at least `formerContributorShare` of the lines held by people, and the file's complexity is at or above the `complexityPercentile` of production code files | Pair on the next change, and write down what the file does |
| `single-owner` | One active developer holds at least `singleOwnerShare` of the lines held by people | Documentation and review rotation. Leave it when the file rarely changes |
| `many-active-developers` | At least `manyActiveAuthors` active developers each hold at least `meaningfulShare` of the lines held by people | Knowledge is spread, so the risk is coordination: look at ownership of changes, not at transfer |
| `inconclusive` | Lines of bots, services and agents, lines with an unknown commit and lines held by identities the mapping has not settled are at least `inconclusiveShare` of the file's lines, or the file's blame is unknown or only bots wrote it | Settle the identities ([identities](identities.md)) before reading the file's ownership |

A file can match several patterns (a single-owner hotspot is also a single owner). `patterns` lists all of them in the order above and `pattern` is the first, so counts are given both ways (`primary` and `matching`). A file that is inconclusive has no other pattern, because its ownership cannot be read. Percentages are shares of the lines held by people, in exact integer arithmetic, and the complexity percentile is the mid-rank percentile among production code files with a blame, taken at the analysed commit and not over the analysis window, so code nobody has changed lately has a complexity. Test files and files that are not code have none, so the complex-code pattern never applies to them, and the summary counts how many files that leaves out (`complexityUnknown`).

Every row also carries the numbers behind the label: `hotspot`, `hotspotPercentile`, `complexity`, `peopleLines`, `activeAuthors`, `formerAuthors`, `topActiveShare`, `formerShare`, `unreliableShare`, `meaningfulAuthors` and `busFactor`. The **bus factor** of a file is the fewest active developers who together hold `busFactorShare` of the lines held by people; it is null when active developers together hold less than that. Developers appear only as counts and shares. The command shows no names, and the report shows names only with `--names` (see [Privacy](#privacy)).

## CLI

Subcommands of the cochange CLI. Every one supports `--json` with a versioned schema.

| Command | Output |
|---|---|
| `cochange blame refresh` | Updates line authorship for files whose blob changed since the last run |
| `cochange abandonment current [--by file\|component]` | Files with lines held by people who have left, ranked, with `abandoned` set for those at the abandonment guideline. With `--by component`, every component that has a measured file, sorted by abandoned share, so a component with no abandoned lines is listed last with share 0. With `--by file`, a file with no lines held by people who have left is omitted, and the table prints a notice with how many of the measured files that is (`summary.files.measured` has the total) |
| `cochange abandonment simulate [--mode rate\|historical\|k-leavers] [--k N] [--trials N] [--horizon P] [--seed S]` | Loss distribution summary, plus top at-risk files and components |
| `cochange abandonment turnover` | Estimated turnover rate per period, with the developer counts behind it (no names) |
| `cochange successors PATH... [--names]` | Ranked successors per file, with the coupling evidence |
| `cochange abandonment patterns` | Every file with a blame, with its knowledge-risk patterns, hotspot and complexity standing, shares held by active and former developers and bus factor, and a summary of the files per pattern (see [Knowledge-risk patterns](#knowledge-risk-patterns)) |
| `cochange abandonment redundancy [--min-authors N] [--min-share PERCENT]` | Share of hotspot files with at least N active authors (default 2) each holding at least the share of lines (default 10 %), with the counts behind it |
| `cochange abandonment trend [--points N]` | Expected loss and KaR at dates one period apart, each from the history and blame then, with one turnover rate and the same settings at every point |
| `cochange abandonment adoption [--at DATE] [--successors N]` | Of the files abandoned at a past date, how many an active developer picked up within the horizon, and how many by one of the top recommended successors using only the history before the date |

## Maintainer commands

These are calibration tools, run by the suite's maintainers on a corpus of repositories to check the model. They stay runnable, but are left out of `--help` listings and of every skill and reference that end users or Claude follow, and the abandonment skill does not run them.

| Command | Output |
|---|---|
| `cochange abandonment backtest [--at DATE] [--horizon P] [--trials N] [--seed S] [--top N]` | At a past date, the predicted at-risk files against the files actually abandoned one horizon later, with precision and recall |

**Backtest.** `--at` is the end of that day in UTC, and the default is one horizon before the analysed commit. The state is taken at the last non-merge commit at or before it. Candidates are files present at both dates and not abandoned at the first. A file is matched across the two dates by its stable file identity, as everywhere else in the suite, so a file renamed in between is the same file. A file is predicted when its probability is at or above `atRiskProbability`: precision and recall need that cut, and every row carries its probability. Files predicted and gone are counted in `goneByOutcome` and not scored. Overrides and hotspot weighting are not applied to the past. Precision and recall are null when their denominator is zero, which is not a score. Renamed files are followed by blame, but the backtest compares files by path, so heavy renaming lowers its scores.

## Privacy

This is the most sensitive analysis in the suite, so it is the most constrained.

- **Off by default.** It needs `cochange.knowledge.enabled: true` in the repo config.
- **No names by default.** Outputs are per file and per component, with developers as counts. `successors --names` is the only command that shows identities, and it shows only *active* developers as recommended reviewers and pair partners. The knowledge report's `--names` is the one other place, and follows the same rule. It never lists leavers, or the people whose departure would cause the most loss.
- **No individual departure ranking.** The CLI does not output "impact if person X leaves". The `k-leavers` mode samples uniformly and reports distributions only. Named scenarios (a specific person or team leaving) are deliberately unsupported. Their output reads as an evaluation of people.
- **Overrides stay local.** Corrections to the activity window (someone on leave, someone gone) go in `.code-health/local/knowledge-overrides.json`, which that folder's own `.gitignore` excludes from git ([suite.md](suite.md#local-state)). It is not part of the cache, so clearing the cache keeps them. Identities never go in the committed config. Every abandonment subcommand and `successors` prints a warning on stderr when that file exists and git tracks it or does not ignore it. The warning creates and changes no file.
- **The knowledge report follows the same rule.** `cochange report knowledge` shows files, components and counts, and names nobody. With `--names` it adds the names (without addresses) of the active developers who hold the lines of the files it lists, in the bus factor table and the pattern tables, as `successors --names` does. It never lists a developer who has left, a bot, or the people whose departure would lose the most, and a notes file written without `--names` does not match one rendered with it.
- **One report, of files.** A configured `simulate` run (no `--mode`, `--k`, `--trials`, `--horizon` or `--seed`) on a clean tree stores `reports/cochange.abandonment.simulate.json` for change-risk to read. It holds files, components and probabilities, and no identities. Nothing else here is stored.
- **Local only.** As for the rest of the suite.

The skill must decline to use these results to assess individuals, to rank people by "risk", or to speculate about who might leave, and say why: the model assumes random turnover and says nothing about any person.

## Skill

Skill name `abandonment`, in `plugins/cochange/skills/abandonment/`. It triggers on questions about knowledge loss, bus or truck factor, onboarding priorities, reviewer assignment for knowledge spread, and "who knows this code".

Workflow:

1. Check enablement and cache freshness, and refresh history and blame if needed. Run `cochange identities check`, and if unmapped identities hold more than the configured share of lines, use the identities skill first. Report the mapped share alongside the results.
2. Run `simulate` in `rate` mode, and in `historical` when there are at least eight quarters of history. Report expected loss, KaR and the tail ratio in plain terms ("in a bad year, expect to lose authorship of around N files; the typical year is M").
3. Present the top-ranked at-risk files with their findings.
4. For files the user wants to act on, run `successors` and propose mitigations from the table, preferring the cheapest that works: assign reviews to successors on the next changes, pair on the next change to a hotspot, and write characterisation tests or a short design note for cold code.
5. Note interactions with the rest of the suite. Simplifying an at-risk complex file (complexity plugin) reduces the knowledge needed to adopt it. Co-locating scattered code (locality plugin) reduces how much someone must know to change it safely.
6. Report the limits: inactivity is a proxy, blame measures authorship rather than understanding, and the 90 % guideline is a convention.

The skill's references include the paper's definitions and the [red-flags](../../shared/red-flags.md) shared reference. *Nonobvious code* and *hard to describe* in at-risk files increase the case for capture before adoption.

## Measurement

| Measure | What it shows | Role |
|---|---|---|
| Expected loss and KaR over time, at the same settings | Knowledge is spreading or concentrating | Primary outcome |
| Share of hotspot files with ≥ 2 active authors holding ≥ 10 % of lines each | Important code has redundancy | Primary outcome |
| Adoption of abandoned files by recommended successors | Recommendations are taken up | Secondary |

A falling KaR after reviewer rotation, with no change in turnover rate, is the evidence that mitigation worked.

## Testing

- Fixture repositories with scripted authors, dates and departures, with hand-computed abandonment for small cases.
- A property test: with *p* = 0 the loss equals current abandonment, with *p* = 1 everything is abandoned, and loss is monotonic in *p*.
- Determinism: a fixed seed gives golden output byte for byte.
- Blame correctness under renames, moves (`-M -C`) and ignore-revs, using fixtures where the locality mover has moved files.
- Skill evals: it declines requests to rank individuals or predict departures; it explains KaR versus expected loss; it proposes successor-based mitigations.

## Configuration

In `cochange.knowledge`:

- `enabled` (default false).
- Activity window, period length, horizon.
- Abandonment guideline (default 90, as a percentage).
- Turnover rate override.
- Trials, α values, seed.
- Ranking mode.
- The knowledge-risk pattern guidelines: `singleOwnerShare`, `formerContributorShare`, `complexityPercentile`, `manyActiveAuthors`, `meaningfulShare`, `inconclusiveShare`, `busFactorShare`.

Local, never committed: `.code-health/local/knowledge-overrides.json`, holding activity overrides by identity.

## Resolved definitions

Where the sections above leave a definition open, these apply. Constants marked *guideline* label and order results and are reported next to the measured value. They never hide a result.

**Blame options and cache.** Authorship is blamed with `-w -M -C` and `--ignore-revs-file` built from `.git-blame-ignore-revs` in the tree at the analysed ref, the same options CodeScene's knowledge analysis relies on (it follows moved code and credits original authors). The cache is keyed by blob, and each row records the commit it was made at and the blame options it was made with (the `-C` setting and the ignore-revs list), so a change to either re-blames. Identities are never stored, so a mailmap change needs no re-blame. `blame refresh` is not behind the opt-in because it stores commit SHAs and line counts only.

**Opt-in.** Every `abandonment` subcommand and `successors` exits 2 with code `knowledge-disabled` when `knowledge.enabled` is false, before it reads history. The overrides file is `{schemaVersion, active, inactive}`, which the CLI only reads. An identity in both lists is a config error. The file holds identities, so it belongs in `.code-health/local/`, which is git-ignored ([suite.md](suite.md#local-state)).

**Configuration units and defaults.** Percentages are numbers from 0 to 100, periods are counted in months.

| Setting | Default | Source |
|---|---|---|
| `abandonmentGuideline` | 90 (percent of lines) | Rigby et al. |
| `concentratedTailRatio` | 3 | *Guideline.* Rigby et al.: tail losses more than three times the expected loss |
| `atRiskProbability` | 10 (percent) | *Guideline.* Judgement call |
| `activityWindowMonths` | 6 | Judgement call. CodeScene documents no inactivity period (ex-developers are configured by hand), so this is the suite's own |
| `periodMonths`, `horizonPeriods` | 3, 4 | Judgement call. One year of quarters |
| `turnoverRate` | null (estimated from history) | Estimated, never invented. A percentage of developers leaving per period, 0 to 100: `15` is 15 percent, and `0.3` is 0.3 percent. Output echoes it as `turnoverRatePercent`, as written. Without it, a history too short to estimate turnover is a usage error that names the key and the units. |
| `minTurnoverPeriods` | 4 | *Guideline.* Judgement call. A rate estimated from fewer observed periods is labelled a weak estimate |
| `mappedShareGuideline` | 80 (percent of lines held by people) | *Guideline.* Judgement call. Results are labelled as depending on unmapped identities below it |
| `trials`, `alphas`, `seed` | 10000, [95, 99], 1 | Rigby et al. for the alphas; the rest are judgement calls |
| `singleOwnerShare` | 90 (percent of lines held by people) | *Guideline.* Judgement call, chosen to match `abandonmentGuideline` |
| `formerContributorShare` | 50 (percent of lines held by people) | *Guideline.* Judgement call. Former contributors hold most of the file |
| `complexityPercentile` | 75 | *Guideline.* Judgement call. Complex means in the top quarter of production code files |
| `manyActiveAuthors`, `meaningfulShare` | 5 developers, 5 (percent of lines held by people) | *Guideline.* Judgement call |
| `inconclusiveShare` | 50 (percent of a file's lines) | *Guideline.* Judgement call. Most of the file's authorship cannot be read |
| `busFactorShare` | 80 (percent of lines held by people) | *Guideline.* Judgement call. The fewest active developers holding this share of a file |

**Active developer.** Active means a committer date within the activity window before the analysed commit, with a month of 30.4375 days. Committer date is used because it is when the work reached the history, and it is the date the suite anchors every window to. Identities go through the mailmap (working tree and local), and bots, services and agents are excluded. It does not depend on the opt-in, and the history `windowMonths` does not govern it.

**Departure and turnover rate.** A tenure ends at a developer's last commit only when the next commit is at least a window later, or when a full window has passed since the last commit. A developer who returns starts a new tenure, so a returner counts as a new hire. The rate for a period is departures over tenures active at its start. Periods that end within the last window, and periods with nobody at risk, are left out. With no usable period the rate is null and commands ask for a configured rate. The tool does not guess one.

**Loss, knowledge at risk and tail ratio.** Loss is measured in lines, with files reported alongside, as an increment over the baseline and as a total. KaR is the nearest-rank percentile of the trials. Expected tail loss is the mean of the trials at or beyond KaR. The headline tail ratio is the one on the increment, since a large baseline dilutes the ratio on the total. Both are printed.

**Per-file tail share and concentration.** `tailShare` is the share of the tail trials in which the file is lost. A tail trial is one whose files lost reach KaR at the lowest alpha. A component's `tailRatio` is the tail ratio of its line increment at the lowest alpha. Each component row prints `tailRatio`, the `guideline` and `ratioToGuideline`. The `concentrated-component` finding is added when the ratio is at or above the guideline, and the finding is a label for investigation. Components are sorted by expected loss, not by the ratio. The `(unassigned)` group is a row like any other, with its size, and is never given the finding, because it is not a unit anyone owns.

**Simulation modes.** `rate` draws one uniform number per developer per trial, so loss never decreases as the rate rises. `historical` resamples the horizon's worth of observed per-period rates with replacement and compounds them. It ignores a configured rate, and `selection.configuredRateIgnored` is true when there was one. It exits 2 when there is no usable period. `k-leavers` needs `--k`, at most the number of active developers.

**Ranking.** A file's rank score is its abandonment probability times its hotspot percentile. The percentile is the mid-rank percentile of the score `cochange hotspots` gives the file, so the word hotspot means the same here as in that command. A file the analysis window never saw change has percentile 0. Ties are broken by probability, then path. The `current` view uses the abandoned share times the percentile, or abandoned lines with `--rank abandonment`. A file is at risk when its probability is at or above `atRiskProbability` and it is not already abandoned. Files below the guideline are still listed, lower down, and `--top N` limits the list with a count of what was left out.

**Successors.** A candidate's score is the sum over coupled files of (degree / 100) times the candidate's eligible changes in the window, plus the candidate's share of lines in the file as a fraction from 0 to 1. The share breaks ties between candidates with the same coupled changes. A file with no coupled files, or none that an active developer has changed, is `no-successor`: the tool has no coordination evidence for it, which is a statement about the evidence and not about ownership. Names are printed only with `--names`, and only for active developers.

**Stored report.** Abandonment output is stored only as `reports/cochange.abandonment.simulate.json`, from a run that takes everything from config. It holds files, components and probabilities, and no identity. `abandoned-touched` in [change-risk](change-risk.md) uses it only when the stamp, config hash, mode and overrides match, and not for changes in the worktree.

## Decisions

- **In the cochange plugin, as a second skill.** It shares the history cache, identity handling, bot filters and coupling (for successors). It answers a different question from hotspots and triggers in different situations, so it is its own skill.
- **Blame at HEAD, not churn shares.** The paper's line-level definition maps directly to what someone inheriting the code will read.
- **Random turnover only.** Modelling individual departure would be invasive and unreliable, and would not improve mitigation advice.

## Open questions

- Whether to weight lines by complexity, so that knowledge of complex code counts for more than knowledge of boilerplate.
- Whether to estimate and apply the turnover rate within tenure bands. Occasional contributors leave at a far higher rate than established ones, so one pooled rate overstates the loss of core authors. Bands describe groups, not people, but a backtest should show the pooled rate is miscalibrated before the model gains that complexity.
- Whether authorship should decay with time since the author last touched the file, since knowledge fades even without turnover.
- Whether agent-authored lines with no human co-author should be attributed to the committer. Today they belong to nobody, as the [identities spec](identities.md) says: agents are not developers, and a commit an agent authored with a `Co-Authored-By` trailer naming a person counts as that person's.

## Milestones

1. Identities skill ([identities.md](identities.md)), then the blame cache with `-M -C`, ignore-revs and mailmap, and `abandonment current`.
2. Turnover estimation and `simulate` in `rate` and `k-leavers` modes, deterministic.
3. `backtest`, a maintainer command that checks the model against a repository's own past.
4. `historical` mode, KaR, tail ratio and expected tail loss.
5. Hotspot-weighted ranking and findings.
6. `successors` from coupling.
7. Skill, evals (including the decline cases) and privacy gating.
