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

## The same question on 30 repositories

`complexity backtest`, a maintainer command ([CONTRIBUTING.md](../CONTRIBUTING.md)), asks the paper's question of a repository's own history. It measures each file at sampled revisions and sets the measures against what the landed changes of the following period did to the file. The figures below are from runs in November 2026 with the defaults: 7 samples over 36 months, so 6 periods of about 6 months, on the default branch of 30 repositories in eight languages.

A correlation is the Spearman rank correlation within each period, averaged over the periods. "With code lines held fixed" is the partial correlation that controls for code lines, the figure the paper does not report.

### Later changes to a file

The outcome is the number of landed changes that touched the file in the following period.

| Measure at the sample | Median | Median with code lines held fixed | Lowest and highest with code lines held fixed | Repositories above 0.10 |
|---|---|---|---|---|
| Code lines | 0.483 | | | |
| Functions | 0.377 | 0.001 | −0.173 to 0.142 | 2 of 30 |
| Cyclomatic complexity, sum | 0.417 | 0.001 | −0.156 to 0.132 | 4 of 30 |
| Cyclomatic complexity, mean | 0.234 | 0.010 | −0.071 to 0.201 | 3 of 30 |
| Cyclomatic complexity, largest | 0.365 | 0.028 | −0.057 to 0.195 | 4 of 30 |
| Share of weighted complexity above the guideline | 0.269 | 0.047 | −0.057 to 0.200 | 5 of 30 |
| Cognitive complexity, sum | 0.389 | 0.020 | −0.075 to 0.152 | 5 of 30 |
| Cognitive complexity, largest | 0.357 | 0.025 | −0.076 to 0.144 | 4 of 30 |
| Indentation complexity | 0.463 | −0.015 | −0.128 to 0.139 | 2 of 30 |
| Prior changes | 0.442 | 0.271 | 0.068 to 0.527 | 28 of 30 |
| Indentation complexity times prior changes | 0.463 | 0.265 | 0.061 to 0.525 | 28 of 30 |

- **Code lines orders the files in every repository**, from 0.280 to 0.724.
- **Complexity adds almost nothing to size.** With code lines held fixed, the median of every cyclomatic and cognitive measure is under 0.05, and none reaches 0.21 in any repository.
- **Cognitive complexity does no better than cyclomatic**, and the share above the guideline no better than either.
- **How often a file changed before is the measure that adds to size**: above 0.10 in 28 of 30 repositories with code lines held fixed. That is the history half of a hotspot, and the basis of the suite's position that history shows cost.

### Lines churned per change

The outcome is lines added plus deleted per landed change, over the files that changed. It is the nearest figure here to the cost of one change.

| Measure at the sample | Median | Median with code lines held fixed | Lowest and highest with code lines held fixed | Repositories above 0.10 |
|---|---|---|---|---|
| Code lines | 0.243 | | | |
| Functions | 0.199 | 0.025 | −0.068 to 0.152 | 3 of 30 |
| Cyclomatic complexity, sum | 0.243 | 0.056 | −0.105 to 0.237 | 10 of 30 |
| Cyclomatic complexity, mean | 0.127 | 0.052 | −0.023 to 0.128 | 3 of 30 |
| Cyclomatic complexity, largest | 0.195 | 0.057 | −0.033 to 0.162 | 3 of 30 |
| Share of weighted complexity above the guideline | 0.137 | 0.036 | −0.033 to 0.119 | 1 of 30 |
| Cognitive complexity, sum | 0.246 | 0.084 | −0.027 to 0.209 | 9 of 30 |
| Cognitive complexity, largest | 0.206 | 0.070 | −0.005 to 0.173 | 5 of 30 |
| Indentation complexity | 0.244 | 0.046 | −0.062 to 0.144 | 5 of 30 |
| Prior changes | 0.131 | 0.018 | −0.044 to 0.113 | 1 of 30 |
| Indentation complexity times prior changes | 0.178 | 0.033 | −0.014 to 0.109 | 2 of 30 |

Code lines still leads, more weakly. The sums of cyclomatic and cognitive complexity keep a small link with code lines held fixed, and prior changes add nothing: a file that changes often does not change in larger pieces.

### Fix share

The outcome is the share of a file's landed changes that are fixes, over the files with at least three changes in a period. It rests on far fewer files: 39 to 1,332 file samples per repository, median 335, and one repository has none.

| Measure at the sample | Median | Median with code lines held fixed | Lowest and highest with code lines held fixed | Repositories above 0.10 |
|---|---|---|---|---|
| Code lines | 0.139 | | | |
| Functions | 0.110 | 0.019 | −0.179 to 0.405 | 4 of 29 |
| Cyclomatic complexity, sum | 0.140 | 0.061 | −0.213 to 0.317 | 10 of 29 |
| Cyclomatic complexity, mean | 0.075 | 0.054 | −0.424 to 0.191 | 8 of 29 |
| Cyclomatic complexity, largest | 0.123 | 0.071 | −0.306 to 0.250 | 5 of 29 |
| Share of weighted complexity above the guideline | 0.080 | 0.041 | −0.258 to 0.299 | 5 of 29 |
| Cognitive complexity, sum | 0.167 | 0.110 | −0.299 to 0.291 | 15 of 29 |
| Cognitive complexity, largest | 0.134 | 0.072 | −0.346 to 0.217 | 10 of 29 |
| Indentation complexity | 0.146 | 0.028 | −0.348 to 0.283 | 4 of 29 |
| Prior changes | 0.080 | −0.009 | −0.172 to 0.113 | 1 of 29 |
| Indentation complexity times prior changes | 0.101 | 0.004 | −0.224 to 0.104 | 2 of 29 |

The sum of cognitive complexity has the highest median with code lines held fixed, and the figures range from clearly negative to clearly positive across repositories. The sample is too small to say more.

### Each repository

Code lines is the raw correlation with later changes. The other columns are with code lines held fixed.

| Repository | Language | Files per period | Landed changes | Code lines | Largest cyclomatic | Cognitive sum | Share above the guideline | Prior changes |
|---|---|---|---|---|---|---|---|---|
| `jellyfin/jellyfin` | C# | 1,037 to 1,221 | 3,111 | 0.497 | 0.094 | 0.115 | 0.152 | 0.227 |
| `dotnet/orleans` | C# | 1,110 to 1,446 | 1,495 | 0.332 | 0.026 | 0.037 | 0.057 | 0.123 |
| `bitwarden/server` | C# | 1,055 to 2,319 | 3,843 | 0.400 | 0.140 | 0.152 | 0.147 | 0.335 |
| `bitcoin/bitcoin` | C++ | 754 to 847 | 3,660 | 0.357 | −0.013 | 0.007 | 0.098 | 0.527 |
| `monero-project/monero` | C++ | 532 to 540 | 1,264 | 0.369 | 0.036 | 0.054 | 0.020 | 0.283 |
| `caddyserver/caddy` | Go | 180 to 209 | 1,071 | 0.655 | 0.022 | 0.045 | 0.029 | 0.190 |
| `go-gitea/gitea` | Go | 1,655 to 2,031 | 5,058 | 0.487 | 0.030 | 0.056 | 0.017 | 0.297 |
| `grafana/k6` | Go | 240 to 420 | 1,972 | 0.400 | 0.069 | 0.064 | 0.112 | 0.218 |
| `prometheus/prometheus` | Go | 323 to 523 | 3,340 | 0.628 | 0.067 | 0.086 | 0.049 | 0.388 |
| `authzed/spicedb` | Go | 357 to 606 | 1,192 | 0.500 | −0.018 | −0.060 | 0.045 | 0.307 |
| `checkstyle/checkstyle` | Java | 376 to 411 | 4,986 | 0.420 | 0.001 | 0.008 | 0.076 | 0.076 |
| `apache/kafka` | Java | 2,417 to 3,154 | 6,583 | 0.378 | −0.011 | 0.003 | 0.088 | 0.239 |
| `ktorio/ktor` | Kotlin | 1,064 to 1,294 | 1,423 | 0.280 | 0.023 | 0.011 | 0.042 | 0.146 |
| `square/okhttp` | Kotlin | 305 to 313 | 1,061 | 0.282 | −0.037 | −0.010 | 0.003 | 0.126 |
| `celery/celery` | Python | 167 to 185 | 1,172 | 0.439 | 0.033 | 0.054 | 0.077 | 0.310 |
| `django/django` | Python | 555 to 584 | 2,924 | 0.453 | −0.050 | −0.075 | −0.016 | 0.255 |
| `pydantic/pydantic` | Python | 83 to 217 | 1,749 | 0.480 | 0.004 | −0.008 | −0.042 | 0.428 |
| `scrapy/scrapy` | Python | 155 to 161 | 1,123 | 0.507 | −0.057 | −0.051 | −0.057 | 0.068 |
| `jj-vcs/jj` | Rust | 120 to 274 | 7,385 | 0.646 | 0.195 | 0.118 | 0.200 | 0.328 |
| `LemmyNet/lemmy` | Rust | 292 to 358 | 1,234 | 0.566 | 0.112 | 0.104 | 0.094 | 0.259 |
| `meilisearch/meilisearch` | Rust | 224 to 500 | 809 | 0.528 | −0.025 | −0.070 | 0.014 | 0.472 |
| `neondatabase/neon` | Rust | 289 to 698 | 4,648 | 0.622 | 0.030 | −0.034 | −0.009 | 0.496 |
| `quickwit-oss/quickwit` | Rust | 420 to 660 | 1,423 | 0.418 | 0.002 | −0.023 | 0.063 | 0.212 |
| `typst/typst` | Rust | 226 to 356 | 2,360 | 0.513 | 0.053 | 0.007 | 0.045 | 0.319 |
| `vectordotdev/vector` | Rust | 961 to 1,089 | 3,691 | 0.355 | 0.044 | 0.030 | 0.039 | 0.180 |
| `excalidraw/excalidraw` | TypeScript | 253 to 410 | 811 | 0.549 | 0.068 | 0.054 | 0.096 | 0.205 |
| `nestjs/nest` | TypeScript | 321 to 341 | 2,830 | 0.450 | 0.062 | 0.086 | 0.106 | 0.143 |
| `microsoft/playwright` | TypeScript | 468 to 643 | 6,682 | 0.549 | −0.022 | −0.010 | −0.016 | 0.426 |
| `vitejs/vite` | TypeScript | 94 to 140 | 3,070 | 0.724 | 0.141 | 0.119 | 0.049 | 0.297 |
| `vitest-dev/vitest` | TypeScript | 253 to 432 | 3,235 | 0.576 | −0.016 | −0.036 | 0.029 | 0.315 |

### What a critical look at the runs found

- **Fixtures and samples counted as production code create a false link.** In the first run vite was the one repository where complexity kept a link after the control. Two thirds of the files counted as its production code were test fixtures under `playground/`, which are small, simple and rarely changed. Nest's samples and integration apps, checkstyle's test inputs and documentation examples, and k6's examples and `testdata` had the same effect. The table above uses the runs with those folders excluded.

| Repository | Folders excluded | Files per period | Code lines | Largest cyclomatic | Cognitive sum | Share above the guideline |
|---|---|---|---|---|---|---|
| `vitejs/vite`, as checked out |  | 235 to 360 | 0.722 | 0.319 | 0.325 | 0.322 |
| `vitejs/vite`, with the folders excluded | `playground/**` | 94 to 140 | 0.724 | 0.141 | 0.119 | 0.049 |
| `nestjs/nest`, as checked out |  | 702 to 740 | 0.369 | 0.204 | 0.215 | 0.165 |
| `nestjs/nest`, with the folders excluded | `sample/**` and `integration/**` | 321 to 341 | 0.450 | 0.062 | 0.086 | 0.106 |
| `checkstyle/checkstyle`, as checked out |  | 676 to 1,268 | 0.198 | 0.056 | 0.079 | 0.066 |
| `checkstyle/checkstyle`, with the folders excluded | `src/it/**`, `src/xdocs-examples/**` and `src/site/**` | 376 to 411 | 0.420 | 0.001 | 0.008 | 0.076 |
| `grafana/k6`, as checked out |  | 297 to 558 | 0.416 | 0.080 | 0.079 | 0.141 |
| `grafana/k6`, with the folders excluded | `examples/**` and `**/testdata/**` | 240 to 420 | 0.400 | 0.069 | 0.064 | 0.112 |

- **`jj-vcs/jj` is the one repository where complexity keeps a link** (0.195 for the largest cyclomatic complexity) with no such folders to explain it. Excluding its examples and benchmarks did not change the figure.
- **A quiet period used to count for as much as a busy one.** Neon had 8 and 3 landed changes in its last two periods, and those periods carried full weight. A period now counts for an outcome only when at least 20 of its files changed, which moved neon's code lines figure from 0.396 to 0.622.
- **A syntax tree thousands of levels deep stopped the run.** A checkstyle test input holds a string built from thousands of `+`, and the extractors' recursion ran out of stack. A file whose tree nests deeper than 1,000 levels is now read as empty and reported.
- **The busier last period is real.** Several repositories have three to six times as many landed changes in the last six months as before. Each period's count was checked against git's own first-parent commit count between the two sampled revisions, and they agree.
- **Inline tests are counted in a Rust file's code lines.** A Rust file's `#[cfg(test)]` module adds to its size, so size is overstated for heavily tested files in the seven Rust repositories.
- **Generated database migrations are counted** in `bitwarden/server` (422 files under `util/*Migrations`).

These are correlations over files, not functions. They say what orders files by later change, not what causes it, and they set no threshold.

## What it means for the suite

- **The harness is an independent outcome measure.** Hidden tests, regression tests that accumulate, and dollars per checkpoint measure whether a later change succeeded and what it cost, without reference to any static score. An agent run with and without the plugins could be compared on solve rate and cost at the later checkpoints.
- **The fit is partial.** A trajectory has at most 8 commits, so history-based findings would be graded weak. The workspaces are far smaller than the repositories the suite is built for.
- **Neither metric is a score to act on.** Verbosity is lint. Erosion is one structural score with a fixed cutoff, and the paper's own table shows it predicts cost less well than line count. `complexity report trends` draws it beside code lines and the mean and largest cyclomatic complexity so that the measures can be compared on a repository's own history, not because any of them is a target.
- **Size and change history carry the signal.** On real repositories a file's complexity mostly repeats its size, and prior change is what adds to it. A complexity ranking is most useful weighted by change, which is what `complexity analyse` does by default and what a hotspot is.
- **Cost is the outcome to measure.** Static measures relate to what the next change costs far more than to whether it passes, which matches the suite's outcomes of change cost and agent effort.
