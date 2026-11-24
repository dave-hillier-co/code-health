# Coupling report

- Repository: repo
- Analysed commit: `8f8f40240b6e83b43f5b0513636448cf4ee76478`
- Date: 2025-12-31
- Config hash: `0000000000000000`
- Evidence grade: weak
- History window: 23 months of usable history; the analysis window is 12 months, 2024-12-31 to 2025-12-31; the previous window for trends is 2024-01-01 to 2024-12-31
- Excluded:
  - commits outside the analysis window: 46

## What the coupling says

**Judgement: what the coupling says about this repository**

Four pairs only, from a history with two authors, so the trends are tentative.

**Co-change between the 7 components with the most changes, degree in percent** (coupling degree in percent; band 1: 20, band 2: 20 to 40, band 3: 40 to 60, band 4: 60 to 80, band 5: 80)

| Row | Column | Value | Mark | Row group | Column group |
| --- | --- | ---: | --- | --- | --- |
| api | web | 80 |  | src | src |
| config | runtime | 50 |  | src | src |

The table lists the cells that have a value or a mark, in row order then column order, each pair once because the matrix is symmetric. Blank cells have no value (45 cells of 49 cells). Bars above the columns and left of the rows mark 2 spans: src (6 rows), top level (1 row). The component map is inferred from folders (no `components` are configured; `cochange components --propose` prints it for review), with 7 components in 2 groups. Rows and columns are components, ordered by group (the group with the most changes first) and within a group by change count, then name. Draws 7 of the 7 components with a change, at most 20, the ones with the most changes; omits 0 components. 0 production code files are in no component. `cochange components` lists the map. A cell is the degree between two components: the changes that touched both, over the mean of the changes that touched each, counted over the same eligible changes and with the same formula as a pair of files; a change counts once for each component it touches. A pair that shares fewer than 5 changes (the support floor) has no value. Production code files only.

**Co-change between the 8 files of the strongest clusters, degree in percent** (coupling degree in percent; band 1: 20, band 2: 20 to 40, band 3: 40 to 60, band 4: 60 to 80, band 5: 80 to 100)

| Row | Column | Value | Mark | Row group | Column group |
| --- | --- | ---: | --- | --- | --- |
| src/api/orders.ts | src/web/orders-view.ts | 80 |  | cluster 1 | cluster 1 |
| src/config/flags.ts | src/runtime/flags.ts | 50 |  | cluster 2 | cluster 2 |
| src/billing/ledger.test.ts | src/billing/ledger.ts | 70 | an expected pair (a test and its code, a header and its source, or another pair listed in the table of expected pairs) | cluster 3 | cluster 3 |
| src/search/index.ts | src/search/ranking.ts | 100 |  | cluster 4 | cluster 4 |

The table lists the cells that have a value or a mark, in row order then column order, each pair once because the matrix is symmetric. Blank cells have no value (56 cells of 64 cells). e is an expected pair (a test and its code, a header and its source, or another pair listed in the table of expected pairs) (2 cells). Boxes along the diagonal mark 4 groups: cluster 1 (2 rows), cluster 2 (2 rows), cluster 3 (2 rows), cluster 4 (2 rows). Rows and columns are ordered by cluster (the numbers of the table of clusters), and within a cluster by sum of coupling over production pairs, then coupled files, then path. Draws 8 files and 4 of 4 clusters, at most 18 files; omits 0 files and 0 clusters (clusters are drawn in the order of the table of clusters, then the files in no cluster with the greatest sum). `cochange clusters` lists every cluster. A cell is the degree of the pair, which is also its colour; shared changes are in the tables of pairs, and a pair that shares fewer than 5 changes (the support floor) has no cell value. Expected pairs are drawn and marked, not left out (1 of 1 expected pair falls within the drawn files). Cluster edges are pairs at or above the degree guideline of 30 percent, so a marked cell outside the boxes is a pair under the guideline.

## Coupled pairs

> **Notice:** 4 pairs reach the support floor of 5 shared changes (cochange.minSupport), which is too few to rank. The floor was not lowered. No other pair shares 3 to 4 changes.

**Most strongly coupled pairs of production files, with how each moved since the previous window. Sorted by degree, then shared changes, then path; pairs under the degree guideline come after the others.**

| # | File | Changes with | Degree (%) | Shared changes | Confidence file to with (%) | Confidence with to file (%) | Distance (folder hops) | Trend |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | src/search/index.ts | src/search/ranking.ts | 100 ▲ | 5 | 100 | 100 | 0 | ↑ stronger (+100 points, shared no change before) |
| 2 | src/api/orders.ts | src/web/orders-view.ts | 80 ▲ | 8 | 80 | 80 | 2 | ↑ stronger (+60 points) |
| 3 | src/config/flags.ts | src/runtime/flags.ts | 50 ▲ | 5 | 50 | 50 | 2 | ↓ weaker (-40 points) |

_Guidelines order and label the rows and decide nothing. Degree (%) 30 (cochange.minDegree), ▲ marks a value above it._

**Judgement: pair 1**

**src/search/index.ts and src/search/ranking.ts**: Verdict: real-locality-review. Shared design decision: the two files change in one commit.

**Judgement: pair 2**

**src/api/orders.ts and src/web/orders-view.ts**: Verdict: real-locality-review. Shared design decision: the two files change in one commit.

**Judgement: pair 3**

**src/config/flags.ts and src/runtime/flags.ts**: Verdict: real-locality-review. Shared design decision: the two files change in one commit.

> **Notice:** 1 pair is an expected pair (1 a test and the code it tests). Expected pairs are not judged; the table below lists them.

**Expected pairs, listed apart and not judged: two test files, a test, fixture or golden file with what it checks, a C or C++ header with its source file, two build manifests of one toolchain, two data files of one format, or a file that is not code (documentation, configuration) with any other file. Sorted by degree, then shared changes, then path; pairs under the degree guideline come after the others.**

| # | File | Changes with | Why expected | Degree (%) | Shared changes |
| ---: | --- | --- | --- | ---: | ---: |
| 1 | src/billing/ledger.test.ts | src/billing/ledger.ts | a test and the code it tests | 70 ▲ | 7 |

_Guidelines order and label the rows and decide nothing. Degree (%) 30 (cochange.minDegree), ▲ marks a value above it._

**Trend of all 4 pairs against 2024-01-01 to 2024-12-31**

| Measure | Value |
| --- | --- |
| Stronger | 2 |
| Stable | 1 |
| Weaker | 1 |
| Pairs that shared no change in the previous window | 1 |
| Stable means a change in degree of at most | 10 points (guideline cochange.couplingTrendTolerance, a judgement call) |
| Eligible changes in the previous window | 46 |

**Distribution of pair degrees (percent)** (pairs per bin)

| Bin | Count (pairs) | Share |
| --- | ---: | ---: |
| 0 to 9 | 0 | 0% |
| 10 to 19 | 0 | 0% |
| 20 to 29 | 0 | 0% |
| 30 to 39 | 0 | 0% |
| 40 to 49 | 0 | 0% |
| 50 to 59 | 1 | 25% |
| 60 to 69 | 0 | 0% |
| 70 to 79 | 1 | 25% |
| 80 to 89 | 1 | 25% |
| 90 to 100 | 1 | 25% |

## Sum of coupling per file

**Sum of coupling per file: the shared changes of all the production pairs a file is in. Sorted by sum, then coupled files, then path**

| # | File | Sum of shared changes | Coupled files | Strongest degree (%) |
| ---: | --- | ---: | ---: | ---: |
| 1 | src/api/orders.ts | 8 | 1 | 80 |
| 2 | src/web/orders-view.ts | 8 | 1 | 80 |
| 3 | src/config/flags.ts | 5 | 1 | 50 |
| 4 | src/runtime/flags.ts | 5 | 1 | 50 |
| 5 | src/search/index.ts | 5 | 1 | 100 |
| 6 | src/search/ranking.ts | 5 | 1 | 100 |

## Clusters

**Clusters of mutually coupled files, with their spread**

| # | Files | Files in cluster | Folders | Spread (mean tree distance) | Mean degree (%) | Findings |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | src/api/orders.ts, src/web/orders-view.ts | 2 | 2 | 2 | 80 | – |
| 2 | src/config/flags.ts, src/runtime/flags.ts | 2 | 2 | 2 | 50 | – |
| 3 | src/billing/ledger.test.ts, src/billing/ledger.ts | 2 | 1 | 0 | 70 | – |
| 4 | src/search/index.ts, src/search/ranking.ts | 2 | 1 | 0 | 100 | – |

## Hidden coupling

> **Notice:** No stored structure hidden result for this commit. Run `structure hidden` to store it, then run this report again.

## What was excluded

**What the run left out, with counts**

| Left out | Count |
| --- | ---: |
| commits outside the analysis window | 46 |
| shallow boundary commits | 0 |
| commits of imported history | 0 |
| commits in the blame ignore file | 0 |
| commits by bots and service accounts | 0 |
| commits trailed by this suite | 0 |
| commits with no file left after filtering | 0 |
| file changes that only rename | 0 |
| file changes matching exclude globs | 0 |
| lockfile changes | 0 |
| generated file changes | 0 |
| vendored file changes | 0 |
| changes over the changeset limit of 30 files, counted on neither side of any ratio | 0 |

## Limits

- Guidelines order and label results. They are heuristics for investigation and decide nothing.
- A pair where either side is a test, a fixture or a golden file, or where the sides are a C or C++ header and its source file, two build or packaging manifests of one toolchain (go.mod and go.work, Dockerfile variants, package.json and its lockfile), or two data or configuration files of one format, is an expected pair. It is listed in its own table and not judged.
- Coupling counts changes that touched both files in the window, over changes at or below the changeset limit; a larger change counts on neither side. A pair that shares fewer than 5 changes (the support floor) is not listed.
- Files that change together may share a design decision, or only a shared constant, a registry, a protocol, tests or generated code. The numbers cannot tell these apart; the judgements say which it is.
- Each table shows the top rows of its result and says how many rows it leaves out; `cochange coupling` and `cochange clusters` print the rest.
- The trend compares each pair's degree with its degree in the previous window of the same length (2024-01-01 to 2024-12-31, 46 eligible changes). A pair that was young or rare then has a noisy earlier degree, and stable means a change of at most 10 points.
- The evidence grade is weak, so history-based results are tentative and static signals should lead.
- A change of merge policy shifts what a commit means, so compare windows within one policy.
- Hidden coupling is read from structure's stored result and never computed here, so none is shown until `structure hidden` has run for this commit.

**Judgement: what limits these results**

Four pairs only, from a history with two authors, so the trends are tentative.
