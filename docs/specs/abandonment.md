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

The paper's thresholds are defaults here, and every one is configurable.

## Scope

In scope:

- Line-level authorship at HEAD, cached incrementally.
- Current abandonment: files already abandoned because their authors are inactive.
- Simulated abandonment: loss distribution, expected loss, KaR and tail ratio, per file and per component.
- Risk weighted by importance: abandonment probability combined with hotspot score, so cold code ranks below code that changes.
- Successor recommendations for at-risk files.
- Backtesting the model against the repository's own history.

Out of scope:

- Predicting which individuals will leave. The simulation samples departures at random from a rate. It never models or ranks a person's likelihood of leaving.
- Judging individuals' contribution or performance.
- HR or organisational data. Activity is inferred from git only, with optional local overrides.

## Concepts

**Author of a line.** The commit that last introduced the line at HEAD, from `git blame -w -M -C --line-porcelain`, ignoring revisions in `.git-blame-ignore-revs`. `-M -C` make moved and copied lines keep their original author, so the locality plugin's move commits do not reset authorship. Formatting sweeps are covered by `-w` and the ignore-revs file. The blame cache stores the commit behind each line range, per blob. Identities, activity and overrides are resolved at query time, so a change to the mailmap never needs a re-blame. The first run blames every file and is the slow step on a large repository, `-C` most of all. It reports progress, can be resumed, and `-C` can be turned off in config.

**Developer identity.** Resolved through a reviewed `.mailmap`, built with the [identities](identities.md) skill. Bot and service authors (from the identities classification) are excluded from the population, and their lines count as owned by nobody. Those lines are left out of both sides of a file's abandoned share, and are reported separately rather than treated as abandoned.

**Active developer.** A developer with at least one commit in the activity window (default 6 months). Inactive developers are treated as having left. That is a proxy: people on leave or moved to another repo look inactive. A local overrides file corrects it (see [Privacy](#privacy)).

**Departure.** A developer has left, as of their last commit, when no further commit follows within the activity window. This is the same test as *active*, so someone who commits every few months stays active throughout and never counts as a leaver in a quiet period. Departures in the most recent activity window cannot be known yet, so those periods are left out of rate estimation.

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
| `abandoned` | Already ≥ threshold abandoned at HEAD | Adoption: assign the top successor; prioritise if it is also a hotspot |
| `at-risk-hot` | High abandonment probability and hotspot | Knowledge transfer now: pairing, reviews by successors, a walkthrough |
| `at-risk-cold` | High abandonment probability, rarely changed | Lightweight capture: a short design note, characterisation tests |
| `concentrated-component` | Component with a high tail ratio | Rotate reviewers within the component |
| `no-successor` | At-risk file with no active developer touching coupled files | Escalate. Nobody is near this code. |

## CLI

Subcommands of the cochange CLI. Every one supports `--json` with a versioned schema.

| Command | Output |
|---|---|
| `cochange blame refresh` | Updates line authorship for files whose blob changed since the last run |
| `cochange abandonment current [--by file\|component]` | Files already abandoned, ranked |
| `cochange abandonment simulate [--mode rate\|historical\|k-leavers] [--k N] [--trials N] [--horizon P] [--seed S]` | Loss distribution summary, plus top at-risk files and components |
| `cochange abandonment turnover` | Estimated turnover rate per period, with the developer counts behind it (no names) |
| `cochange successors PATH... [--names]` | Ranked successors per file, with the coupling evidence |
| `cochange abandonment backtest [--at DATE]` | At a past date, the predicted at-risk files against the files actually abandoned one horizon later |

## Privacy

This is the most sensitive analysis in the suite, so it is the most constrained.

- **Off by default.** It needs `cochange.knowledge.enabled: true` in the repo config.
- **No names by default.** Outputs are per file and per component, with developers as counts. `successors --names` is the only command that shows identities, and it shows only *active* developers as recommended reviewers and pair partners. It never lists leavers, or the people whose departure would cause the most loss.
- **No individual departure ranking.** The CLI does not output "impact if person X leaves". The `k-leavers` mode samples uniformly and reports distributions only. Named scenarios (a specific person or team leaving) are deliberately unsupported. Their output reads as an evaluation of people.
- **Overrides stay local.** Corrections to the activity window (someone on leave, someone gone) go in `.code-health/local/knowledge-overrides.json`, which that folder's own `.gitignore` excludes from git ([suite.md](suite.md#local-state)). It is not part of the cache, so clearing the cache keeps them. Identities never go in the committed config.
- **Local only.** As for the rest of the suite.

The skill must decline to use these results to assess individuals, to rank people by "risk", or to speculate about who might leave, and say why: the model assumes random turnover and says nothing about any person.

## Skill

Skill name `abandonment`, in `plugins/cochange/skills/abandonment/`. It triggers on questions about knowledge loss, bus or truck factor, onboarding priorities, reviewer assignment for knowledge spread, and "who knows this code".

Workflow:

1. Check enablement and cache freshness, and refresh history and blame if needed. Run `cochange identities check`, and if unmapped identities hold more than the configured share of lines, use the identities skill first. Report the mapped share alongside the results.
2. Run `simulate` in `rate` mode, and in `historical` when there are at least eight quarters of history. Report expected loss, KaR and the tail ratio in plain terms ("in a bad year, expect to lose authorship of around N files; the typical year is M"). Give the backtest's precision and recall with them, so the user knows how well the model has predicted this repository's own past.
3. Present the top-ranked at-risk files with their findings.
4. For files the user wants to act on, run `successors` and propose mitigations from the table, preferring the cheapest that works: assign reviews to successors on the next changes, pair on the next change to a hotspot, and write characterisation tests or a short design note for cold code.
5. Note interactions with the rest of the suite. Simplifying an at-risk complex file (complexity plugin) reduces the knowledge needed to adopt it. Co-locating scattered code (locality plugin) reduces how much someone must know to change it safely.
6. Report the limits: inactivity is a proxy, blame measures authorship rather than understanding, and the 90 % threshold is a convention.

The skill's references include the paper's definitions and the [red-flags](red-flags.md) shared reference. *Nonobvious code* and *hard to describe* in at-risk files increase the case for capture before adoption.

## Measurement

| Measure | What it shows | Role |
|---|---|---|
| Expected loss and KaR over time, at the same settings | Knowledge is spreading or concentrating | Primary outcome |
| Share of hotspot files with ≥ 2 active authors holding ≥ 10 % of lines each | Important code has redundancy | Primary outcome |
| Backtest precision and recall at a past date | The model is calibrated for this repository | Model validity |
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
- Abandonment threshold (default 0.9).
- Turnover rate override.
- Trials, α values, seed.
- Ranking mode.

Local, never committed: `.code-health/local/knowledge-overrides.json`, holding activity overrides by identity.

## Decisions

- **In the cochange plugin, as a second skill.** It shares the history cache, identity handling, bot filters and coupling (for successors). It answers a different question from hotspots and triggers in different situations, so it is its own skill.
- **Blame at HEAD, not churn shares.** The paper's line-level definition maps directly to what someone inheriting the code will read.
- **Random turnover only.** Modelling individual departure would be invasive and unreliable, and would not improve mitigation advice.

## Open questions

- Whether to weight lines by complexity, so that knowledge of complex code counts for more than knowledge of boilerplate.
- Whether to estimate and apply the turnover rate within tenure bands. Occasional contributors leave at a far higher rate than established ones, so one pooled rate overstates the loss of core authors. Bands describe groups, not people, but the backtest should show the pooled rate is miscalibrated before the model gains that complexity.
- Whether authorship should decay with time since the author last touched the file, since knowledge fades even without turnover.
- How to treat code authored by agents, which have no knowledge to lose. One option is to attribute agent-authored lines to the reviewing or committing human. The identities skill already records agent trailers, so this is a policy choice rather than a detection problem.

## Milestones

1. Identities skill ([identities.md](identities.md)), then the blame cache with `-M -C`, ignore-revs and mailmap, and `abandonment current`.
2. Turnover estimation and `simulate` in `rate` and `k-leavers` modes, deterministic.
3. `backtest`, so the model is checked against this repository's own past before anything presents its numbers.
4. `historical` mode, KaR, tail ratio and expected tail loss.
5. Hotspot-weighted ranking and findings.
6. `successors` from coupling.
7. Skill, evals (including the decline cases) and privacy gating.
