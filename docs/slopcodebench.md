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
| Lines of code per file | Yes | `complexity files`, column `codeLines` |
| Max CC | Yes, per file | `complexity files` holds the sum and the maximum of each metric over a file's top-level functions |
| Mean CC | Derivable | The per-file sum divided by the function count, or from the `analyse` rows |
| Erosion | Derivable, not computed | Every input is in the `analyse --json` rows: `cyclomatic` and `length` per function |
| Clone ratio | No | The suite has no duplication detection |
| ast-grep hits per LOC | No | A lint measure, outside the suite's scope |

The paper considered cognitive complexity and did not use it, so the table has no figure for the suite's primary ranking metric.

## What it means for the suite

- **The harness is an independent outcome measure.** Hidden tests, regression tests that accumulate, and dollars per checkpoint measure whether a later change succeeded and what it cost, without reference to any static score. An agent run with and without the plugins could be compared on solve rate and cost at the later checkpoints.
- **The fit is partial.** A trajectory has at most 8 commits, so history-based findings would be graded weak. The workspaces are far smaller than the repositories the suite is built for.
- **Neither metric is worth adopting.** Verbosity is lint. Erosion is one structural score with a fixed cutoff, and the paper's own table shows it predicts cost less well than line count.
- **Cost is the outcome to measure.** Static measures relate to what the next change costs far more than to whether it passes, which matches the suite's outcomes of change cost and agent effort.
