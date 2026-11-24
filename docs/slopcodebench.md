# SlopCodeBench

SlopCodeBench (SCBench, [scbench.ai](https://www.scbench.ai/)) is a benchmark of coding agents that extend their own code over several specification changes. This page records what it measures, what its paper reports about how well static measures predict the next change, and which of those measures the suite already computes.

Every figure here is from version 2 of the paper, [arXiv 2603.24755v2](https://arxiv.org/abs/2603.24755v2) (Orlanski et al., May 2026). The leaderboard on the site is updated separately and its numbers differ.

## What it is

- 36 hand-written problems with 196 checkpoints in total, 3 to 8 per problem. Only the Python track is evaluated.
- At the first checkpoint the agent writes a program from a specification. At each later checkpoint it receives a new specification and its own previous workspace, in a fresh container.
- The specification describes behaviour at a command line or API boundary. It prescribes no internal interfaces and ships no tests.
- 15 models were run in their own harnesses (Claude Code, Codex CLI and others). No agent solved any problem at every checkpoint. The best strict solve rate was 14.8%.

## Its tests

The tests are hidden pytest files, one per checkpoint, that run the program and compare its output. They never read the code.

| Category | What it covers |
|---|---|
| Core | Behaviour stated or shown in the specification |
| Error | Failure modes |
| Functionality | Hidden tests that check correctness exhaustively |
| Regression | Every test from the earlier checkpoints |

A checkpoint is solved when every test passes. The paper also reports "isolated" (all tests except regression) and "core" (core tests only). It records the cost in dollars of each checkpoint.

## Its two quality metrics

**Structural erosion** is the share of complexity that sits in complex functions:

```
mass(f)  = CC(f) × √SLOC(f)
erosion  = sum of mass(f) for functions with CC(f) > 10
           ÷ sum of mass(f) for all functions
```

CC is cyclomatic complexity. The cutoff of 10 is taken from Radon.

**Verbosity** is the fraction of lines that are flagged by any of 137 ast-grep rules or are part of a clone. The paper does not say which clone detector it uses.

Verbosity is a lint measure, and the suite does not try to reproduce it. Over a trajectory the lint part hardly moves: duplication grows 96% while ast-grep violation density grows 0.3%.

## What predicts the next checkpoint

Table 6 of the paper correlates each measure, taken on the workspace at one checkpoint, with two results of the next checkpoint: whether it passes, and what it costs.

| Measured at checkpoint N | Passing N+1 | Cost of N+1 |
|---|---|---|
| Erosion as reported (CC > 10, √SLOC) | −0.018 | 0.167 |
| Best erosion variant (CC > 12, linear SLOC) | −0.136 | 0.095 |
| LOC | −0.212 | 0.502 |
| Mean CC | −0.046 | 0.218 |
| Max CC | −0.117 | 0.356 |
| Clone ratio | −0.042 | 0.114 |
| ast-grep hits per LOC | −0.052 | 0.151 |

- Every measure correlates more strongly with cost than with passing.
- No measure predicts passing. The strongest is LOC at −0.212.
- Size predicts cost best. LOC accounts for about 25% of the variation in cost (0.502 squared) and erosion for about 3%.
- Erosion is a ratio, so it removes size by construction. The paper tried nine variants of the cutoff and the size term, and none predicted passing.

What the table does not establish:

- The paper does not say which correlation coefficient it used, or how many checkpoints the table covers.
- The correlations are pooled across problems and models, which differ in difficulty and strength. The paper reports no figure that controls for either.
- The paper reports no correlation with cost after controlling for size, so the table cannot say whether complexity predicts cost beyond what line count already does. An agent reads more tokens in a larger workspace, so part of the LOC figure is mechanical.
- The workspaces are small Python programs written by one agent over at most 8 checkpoints.

## A lower score without a better outcome

The paper tested a prompt that lists verbose and over-engineered patterns to avoid ("anti-slop") against the plain prompt.

- Verbosity was 27.5% to 35.6% lower and erosion 34.3% to 57.6% lower, depending on the model.
- The strict solve rate fell by 2.4 points on average.
- Cost per checkpoint rose by 12.1% on average.
- The paper's summary is that prompting improves initial quality "with little impact on the iterative degradation".

This is a measured case of the position in [basis.md](basis.md) that a score is not an outcome: both scores fell, and neither outcome improved.

## Comparison with human repositories

The paper computed both metrics on 473 open-source Python repositories, sampling up to 30 commits from each.

| | Verbosity | Erosion |
|---|---|---|
| Human repositories at HEAD | 0.19 | 0.34 |
| Agent checkpoints | 0.44 | 0.68 |
| Rise per checkpoint, agents | 0.0144 | 0.0264 |
| Rise per sampled commit, human median | 0.0022 | 0.0053 |

Erosion rises in 77% of agent trajectories and in 53% of the human repositories.

## Which of these measures the suite computes

| Measure | In the suite | Where |
|---|---|---|
| Cyclomatic complexity per function | Yes | `complexity analyse`, metric `cyclomatic`. The default `warn` guideline is 10, the same value as the erosion cutoff |
| Lines of code per function | Yes | `complexity analyse`, metric `length`: lines of code with blank and comment lines excluded |
| Lines of code per file | Yes | `complexity files`, column `codeLines`, and per folder over time in `complexity report trends` |
| Max CC | Yes | `complexity files` holds the sum and the maximum of each metric over a file's top-level functions, and `complexity report trends` the largest value per folder over time |
| Mean CC | Yes | `complexity report trends`, per folder over time |
| Erosion | Yes, with the suite's guideline as the cutoff | `complexity report trends`: the percent of weighted complexity in functions above the cyclomatic guideline, for the repository and each folder at sampled revisions |
| Clone ratio | No | The suite has no duplication detection |
| ast-grep hits per LOC | No | A lint measure, outside the suite's scope |

The paper considered cognitive complexity and did not use it, so the table has no figure for the suite's primary ranking metric.

## The same question on five repositories

`complexity backtest`, a maintainer command ([CONTRIBUTING.md](../CONTRIBUTING.md)), asks the paper's question of a repository's own history. It measures each file at sampled revisions and sets the measures against what the landed changes of the following period did to the file. The figures below are from a run in November 2026 with the defaults: 7 samples over 36 months, so 6 periods of about 6 months, on the default branch of each repository.

Each cell is the Spearman correlation with the number of landed changes that touched the file in the following period, then the same with code lines held fixed.

| Measure at the sample | orleans (C#) | spicedb (Go) | django (Python) | vite (TypeScript) | vector (Rust) |
|---|---|---|---|---|---|
| Code lines | 0.332 | 0.500 | 0.453 | 0.722 | 0.355 |
| Largest cyclomatic complexity | 0.271, 0.026 | 0.369, −0.018 | 0.308, −0.050 | 0.707, 0.319 | 0.272, 0.044 |
| Mean cyclomatic complexity | 0.214, 0.014 | 0.181, −0.061 | 0.107, −0.037 | 0.655, 0.244 | 0.198, 0.038 |
| Share of weighted complexity above the guideline | 0.188, 0.057 | 0.312, 0.045 | 0.222, −0.016 | 0.643, 0.322 | 0.180, 0.039 |
| Largest cognitive complexity | 0.276, 0.034 | 0.348, −0.028 | 0.292, −0.076 | 0.703, 0.309 | 0.247, 0.014 |
| Indentation complexity | 0.321, −0.028 | 0.473, −0.030 | 0.432, −0.020 | 0.721, 0.125 | 0.335, −0.047 |
| Prior changes | 0.207, 0.123 | 0.482, 0.307 | 0.412, 0.255 | 0.689, 0.381 | 0.280, 0.180 |
| Indentation complexity times prior changes | 0.218, 0.127 | 0.498, 0.283 | 0.423, 0.248 | 0.715, 0.398 | 0.292, 0.171 |
| Files, summed over the periods | 7,524 | 2,784 | 3,385 | 1,831 | 6,142 |

- **Code lines orders the files best in every repository**, as it did in the paper.
- **In four of the five, complexity adds nothing to size.** With code lines held fixed, every cyclomatic and cognitive measure is within 0.08 of zero on orleans, spicedb, django and vector. Cognitive complexity does no better than cyclomatic.
- **Vite is the exception**, with 0.24 to 0.33 left after the control. The cause has not been looked into.
- **How often a file changed before is the one measure that adds to size everywhere**: 0.12 to 0.38 with code lines held fixed. That is the history half of a hotspot, and the basis of the suite's first position, that history shows cost.
- **The share above the guideline has the weakest raw link of the cyclomatic measures** on orleans, vector and vite and sits between the mean and the largest value on the other two, which agrees with the paper's ranking of erosion below max CC.
- **Lines churned per change** follows the same pattern more weakly: code lines gives 0.18 to 0.43, and the complexity partials are under 0.13 outside vite.
- **Fix share rests on few files**: 183 to 518 file samples per repository had three or more changes in a period. The partials range from −0.11 to 0.25 with no measure consistent across the five.

These are correlations over files, not functions, on five repositories. They say what orders files by later change, not what causes it, and they set no threshold.

## What it means for the suite

- **The harness is an independent outcome measure.** Hidden tests, regression tests that accumulate, and dollars per checkpoint measure whether a later change succeeded and what it cost, without reference to any static score. An agent run with and without the plugins could be compared on solve rate and cost at the later checkpoints.
- **The fit is partial.** A trajectory has at most 8 commits, so history-based findings would be graded weak. The workspaces are far smaller than the repositories the suite is built for.
- **Neither metric is a score to act on.** Verbosity is lint. Erosion is one structural score with a fixed cutoff, and the paper's own table shows it predicts cost less well than line count. `complexity report trends` draws it beside code lines and the mean and largest cyclomatic complexity so that the measures can be compared on a repository's own history, not because any of them is a target.
- **Size and change history carry the signal.** On real repositories a file's complexity mostly repeats its size, and prior change is what adds to it. A complexity ranking is most useful weighted by change, which is what `complexity analyse` does by default and what a hotspot is.
- **Cost is the outcome to measure.** Static measures relate to what the next change costs far more than to whether it passes, which matches the suite's outcomes of change cost and agent effort.
