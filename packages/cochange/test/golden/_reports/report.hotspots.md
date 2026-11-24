# Hotspots

- Repository: repo
- Analysed commit: `e280410157605ca8c1a5a2f33e70539f4a18188d`
- Date: 2024-06-15
- Config hash: `0000000000000000`
- Evidence grade: weak
- History window: 17.3 months of usable history; the analysis window is 12 months, 2023-06-15 to 2024-06-15
- Excluded:
  - commits outside the analysis window: 1

## What the picture says

**Judgement: what the picture says**

Nesting and change meet in one file, and the history is short.

## Map of the code

**The code, nested by folder: size is lines, colour is revisions in the window, outlined tiles are the friction list** (the items by lines, marked first, then largest first; band is revisions in the window, band 1: 2 to 5, band 2: 5 to 6, band 3: 6 to 7, band 4: 7 to 8, band 5: 8; band 1: 2 items, 12 lines; band 2: 2 items, 14 lines)

| # | Path | Size (lines) | Colour (revisions in the window) | Band |
| ---: | --- | ---: | ---: | ---: |
| 1 | src/core/engine.ts | 13 | 5 | 2 |
|  | src/legacy/old.ts | 7 | 3 | 1 |
|  | src/ui/page.ts | 5 | 2 | 1 |
|  | src/core/util.ts | 1 | 5 | 2 |

The map draws all 4 production code files at HEAD (26 lines), including 0 that nothing in the window changed (0 revisions). The band edges sit at the 50th, 75th, 90th and 97th percentile of the revisions of the 4 files that changed, so band 5 is the most changed and says nothing about good or bad.

## Friction list

1 of 4 files are in the top 50 percent in change frequency and are complex. A file is complex here when it has a function above the cognitive complexity guideline, read from the stored `complexity analyse` result. The list is ordered by hotspot score.

**Friction list: files in the top change-frequency percentile with a function above the cognitive guideline, by hotspot score**

| # | File | Revisions | Frequency percentile | Functions above the cognitive guideline | Complexity (indentation) | Complexity percentile | Last changed | Landed changes | Fixes landed | Fix share of landed changes (%) | Fixes in review | Flag |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | src/core/engine.ts | 5 | 75 ▲ | 1 | 36 | 87.5 | 2024-06-15 | 5 | 0 | 0 | 0 | hotspot |

_Guidelines order and label the rows and decide nothing. Frequency percentile 50 (cochange.hotspotPercentile), ▲ marks a value above it._

**Judgement: src/core/engine.ts, red flag or code smell**

Verdict: none-applies. The file changes often and is deeply nested.

**Judgement: src/core/engine.ts, recommendation**

Verdict: refactor. The file changes often and is deeply nested.

## History of the top files

**Complexity and size of the first friction files across their history (cochange trend). The direction compares the first sample with the last sample only: worsening is a rise of at least the guideline, improving a fall of at least the guideline, and a fall in the last step does not change it**

| # | File | Revisions in history | Direction, first sample to last sample | Change in complexity, first sample to last sample (%) | Peak complexity | Lines at first sample | Lines at last sample |
| ---: | --- | ---: | --- | ---: | ---: | ---: | ---: |
| 1 | src/core/engine.ts | 6 | stable | 0 | 36 | 13 | 13 |

_Guidelines order and label the rows and decide nothing. Change in complexity, first sample to last sample (%) 20 (the trend guideline for worsening), ▲ marks a value above it._

**src/core/engine.ts: indentation complexity across its history** (indentation complexity, oldest first)

| Period | indentation complexity |
| --- | ---: |
| 2023-01-05 | 36 |
| 2024-02-01 | 36 |
| 2024-03-20 | 36 |
| 2024-04-20 | 36 |
| 2024-05-25 | 36 |
| 2024-06-15 | 36 |

## X-Ray: src/core/engine.ts

**X-Ray of src/core/engine.ts: its functions, most complex first**

| # | Function | Lines | Length | Cognitive | Nesting | Cyclomatic | Fixes | Code smells |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | tune | 1-20 | 14 | 30 ▲ | 6 ▲ | 12 ▲ | 2 | cognitive-high, nesting-warn |
| 2 | start | 1-20 | 14 | 4 | 6 ▲ | 12 ▲ | 0 | none |

_Guidelines order and label the rows and decide nothing. Cognitive 15 (complexity.guidelines, the warn level), ▲ marks a value above it; Nesting 4 (complexity.guidelines, the warn level), ▲ marks a value above it; Cyclomatic 10 (complexity.guidelines, the warn level), ▲ marks a value above it._

> **Notice:** The table has no revisions column: the stored fix result lists only the functions that have a fix, so it cannot give the revisions of the others. `complexity report xray src/core/engine.ts` shows them for its most complex functions, and `complexity analyse src/core/engine.ts --with-fixes --limit all` for every function.

## Limits

- Guidelines order and label results. They are heuristics for investigation and decide nothing.
- The friction list is the files at or above the 50th percentile of change frequency (cochange.hotspotPercentile) that have a function above the cognitive complexity guideline (from the stored `complexity analyse` result). A percentile is a rank among the 4 files ranked, so it moves when files are added.
- The friction list shows 1 of 1 files; the judgement covers the first 1 (cochange.hotspotJudged), the history table covers the first 1 (sparklines of the first 1) and the X-Ray the first 1.
- The Complexity column is the file's indentation complexity computed by this report; `complexity files` stores the same figure for this commit.
- Revisions count every commit that touched the file in the window. Landed changes count the merged changes (a pull request, or a commit on the main line) that touched it, so they are fewer than revisions when a change has several commits; the fix share is fixes landed divided by landed changes. A fix is a count of commit messages, not of defects, and fixes in review are fix-like commits made on a branch before it merged.
- The evidence grade is weak, so history-based results are tentative and static signals should lead.

**Judgement: what limits these results**

Nesting and change meet in one file, and the history is short.
