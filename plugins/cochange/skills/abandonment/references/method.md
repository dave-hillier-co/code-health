# The method, and every guideline

## Definitions (Rigby, Zhu, Donadelli and Mockus, ICSE 2016)

- **Author of a line.** The commit that last introduced the line at the analysed commit, from `git blame -w -M -C`, ignoring revisions in `.git-blame-ignore-revs`. `-w` ignores whitespace, `-M` and `-C` make moved and copied lines keep their original author, and the ignore-revs file covers formatting sweeps. The blame cache stores the commit behind each line range and never an identity, so a mailmap change never needs a new blame.
- **Developer.** A person after the reviewed `.mailmap`. Bots, services and agents are not in the population. Their lines belong to nobody and are on neither side of a file's abandoned share. They are reported apart as `nonPersonLines`.
- **Active.** At least one commit in the activity window (`cochange.knowledge.activityWindowMonths`, default 6) ending at the analysed commit. Inactive developers are treated as having left. Overrides in `.code-health/local/knowledge-overrides.json` correct this: `active` for people on leave, `inactive` for people who have gone.
- **Abandoned line.** Its last author is not active.
- **Abandoned file.** At least `cochange.knowledge.abandonmentThreshold` percent (default 90) of the lines held by people are abandoned. The test is exact integer arithmetic: 9 of 10 is abandoned at 90.
- **Departure.** A developer leaves, as of their last commit, when no further commit follows within the activity window. Someone who commits every few months stays active throughout. Someone who returns after a longer gap starts a new tenure.
- **Turnover rate.** Per period (`cochange.knowledge.periodMonths`, default 3): developers whose departure falls in the period, over developers on the team at its start. Departures in the last activity window cannot be known yet, so the periods that end inside it are left out. The pooled rate is departures over developer-periods across the usable periods. A rate stated in `cochange.knowledge.turnoverRate` (a percentage per period) replaces the estimate in `rate` mode.
- **Months** are 30.4375 days everywhere, so windows and periods are exact lengths of time.

## Simulation

All simulation is deterministic. Each trial draws from a generator seeded by the run's seed and the trial's number, so the same repository, config and seed give identical output, and the seed is in the output.

| Mode | Who leaves in a trial |
|---|---|
| `rate` (default) | Each active developer independently, with probability `1 - (1 - q)^h` for a per-period rate q over a horizon of h periods |
| `historical` | h of the repository's own per-period rates are sampled with replacement and compounded into one probability, then applied as in `rate`. It includes bad quarters, and the paper found it gives fatter tails. |
| `k-leavers` | Exactly k active developers, uniformly. A stress test that replaces the truck factor with a distribution. |

Defaults: 10,000 trials, a horizon of 4 periods (a year), alphas 95 and 99.

Per trial the loss is lines and files abandoned once the leavers and everyone already inactive are removed. Across trials:

- **Expected loss** is the mean.
- **Knowledge at risk (KaR)** at alpha is the nearest-rank percentile: the loss exceeded in only (100 - alpha) percent of trials.
- **Tail ratio** is KaR over expected loss. The paper found losses more than three times the expected loss in the tail, and more than five times under historical simulation.
- **Expected tail loss** is the mean of the losses at or beyond KaR. It shows how bad the tail is, not only where it starts. This is an extension to the paper.

Loss is reported as the **increment** over what is already abandoned, which is the only part that can still be prevented, and as the **total**, which adds the baseline back. The tail ratio of the total is over the total expected loss, so a large baseline lowers it. Read the ratio on the increment.

Per file: the **probability** of being abandoned (the share of trials), and the **tail share**, the share of the worst trials (by files lost, at the lowest alpha) in which it is lost. A file with several holders is lost mostly in bad scenarios, so its tail share is far above its probability.

## Ranking and findings

Raw abandonment puts old, stable code first. By default files are ranked by abandonment probability times hotspot percentile (the rank percentile of the file's hotspot score among files that changed in the analysis window, 0 for files that did not), so code that keeps changing comes first. `--rank abandonment` or `cochange.knowledge.rank` gives the raw view.

- `abandoned`: already abandoned.
- `at-risk-hot` and `at-risk-cold`: probability at least `cochange.knowledge.atRiskProbability` percent (default 10), for a file that is or is not a hotspot.
- `concentrated-component`: tail ratio of the component's increment in lines, at the lowest alpha, at or above the guideline `cochange.knowledge.concentratedTailRatio` (default 3, from the paper's finding that tail losses exceed three times the expected loss). Each component row prints `tailRatio`, `guideline` and `ratioToGuideline`, so a ratio just under the guideline is visible. Needs `components` in the config. The unassigned group is listed with its size and never given the finding.
- `no-successor`: an abandoned or at-risk file where no active developer has changed any file that changes with it.

## Successors

Coordination requirements (Cataldo et al.). For a file, each active developer scores the sum, over files coupled with it (the suite's coupling at `cochange.minSupport` and `cochange.minDegree`), of the coupling degree as a fraction times the developer's changes to that file in the analysis window, plus their share of the people's lines in the file. Bulk changes above `cochange.maxChangesetSize` count for nothing. The paper recommended the right successor 34 to 48 percent of the time, so treat a successor as a good place to start, and having successors reduced expected loss by up to 15 percent. Most abandoned files were adopted by existing experts, not newcomers.

## Backtest

At a past date (default one horizon before the analysed commit): history up to the date only gives the turnover rate, the blame of the commit then and who was active then. Files present at both dates and not abandoned at the first are the candidates. Those whose probability reaches `atRiskProbability` are predicted. The actual set is the candidates abandoned at the date one horizon later. Precision is the share of predicted files that were abandoned, and recall the share of abandoned files that were predicted. `expectedAbandoned` sets the number the model expected beside the number that happened. Activity overrides are not applied to a past date, and the backtest uses `rate` mode without hotspot weighting.
