# Sample report

- Repository: demo
- Analysed commit: `0123456789abcdef0123456789abcdef01234567`
- Date: 2025-06-01
- Config hash: `abcdef0123456789`
- Evidence grade: moderate
- History window: 8 months of history
- Excluded:
  - generated files: 3

## Overview

Run `structure cycles` and read \<the table\>.

**Judgement: look**

**src/a.ts**: Verdict: act. Split it \<now\>.

**Top files**

| # | File | Cognitive | Confidence |
| ---: | --- | ---: | ---: |
| 1 | src/a\|b.ts | 40 ▲ | 80 |
| 2 | src/c.ts | 15 | 20 ▼ |
| 3 | src/d.ts | – | 50 |

_Guidelines order and label the rows and decide nothing. Cognitive 15 (a judgement call), ▲ marks a value above it; Confidence 50, ▼ marks a value below it._

_Showing 3 of 40 files; 37 not shown._

> **Limit:** History is short.

## Charts

**Files by lines and revisions** (the items by lines, marked first, then largest first; band is revisions, band 1: 1, band 2: 3, band 3: 7, band 4: 12; band 1: 1 item, 60 lines; band 2: 1 item, 120 lines; band 3: 1 item, 200 lines; band 4: 1 item, 400 lines; no value: 1 item, 90 lines)

| Path | Size (lines) | Colour (revisions) | Band |
| --- | ---: | ---: | ---: |
| src/core/engine.ts | 400 | 12 | 4 |
| src/ui/page.ts | 200 | 7 | 3 |
| src/core/util.ts | 120 | 3 | 2 |
| src/ui/form.ts | 90 | none | none |
| docs/guide.md | 60 | 1 | 1 |

1 item of no size not drawn.

**Changes per month** (changes, oldest first)

| Period | changes |
| --- | ---: |
| 2025-01 | 4 |
| 2025-02 | 9 |
| 2025-03 | 6 |

**Complexity of files** (files per bin)

| Bin | Count (files) | Share |
| --- | ---: | ---: |
| 0 to 9 | 30 | 75% |
| 10 to 19 | 8 | 20% |
| 20 or more | 2 | 5% |

**Revisions against complexity** (Revisions against Complexity)

| # | Point | Revisions | Complexity | Quadrant |
| ---: | --- | ---: | ---: | --- |
| 1 | src/core/engine.ts | 40 | 300 | look first |
| 2 | src/ui/page.ts | 12 | 90 | look first |

_Log scale on Revisions (horizontal) and Complexity (vertical): each tick is ten times the one before, because the values have a long tail._

_1 files have a value below 1 on a log axis and are drawn on the axis minimum, 1._

_Guidelines: vertical dashed line at 8: the 75th percentile of revisions; horizontal dashed line at 40: the 75th percentile of complexity. A guideline orders and labels results; it decides nothing._

_Of 7 files: 3 look first, 1 complex, stable, 1 busy, simple, 2 quiet._

_Squares are highlighted files. The table lists 2 of 3 highlighted files, in the order given, and the drawing names them; 1 are not listed and are drawn as squares without a name._

**Shared changes** (shared changes; band 1: 1, band 2: 5, band 3: 9)

| Row | Column | Value | Mark |
| --- | --- | ---: | --- |
| a.ts | b.ts | 5 |  |
| a.ts | c.ts | 1 |  |
| b.ts | a.ts | 5 |  |
| b.ts | c.ts | 9 |  |

The table lists the cells that have a value or a mark, in row order then column order. Blank cells have no value (2 cells of 6 cells).

**Functions by cognitive complexity** (cognitive complexity against a guideline of 15, with revisions and fixes. Guideline from a judgement call.)

| Function | cognitive complexity | Guideline | Position | Revisions | Fixes |
| --- | ---: | ---: | --- | ---: | ---: |
| parse | 30 | 15 | above guideline | 12 | 4 |
| format | 10 | 15 | below guideline | 3 | 0 |
| plain | 5 | 15 | below guideline | none | none |

The chart omits 2 functions: the least complex of the file.

**Moves of units to their target folders**

| # | Unit | From | To | Gain | Status |
| --- | --- | --- | --- | ---: | --- |
| 1 | src/a/util/x.ts | src/a/util | src/a | 12 | move |
| B1 | src/b/web/y.ts | src/b/web | src/b/core | 6 | blocked by src/b/web/x.ts |
| R1 | docs/z.md | docs |  |  | review |

- Each folder is a row, indented under its parent. A folder with nothing of its own and one child is joined to that child.
- An arrow runs from the folder a unit is in to the folder it moves to. Its number is the unit's number in the table, its thickness grows with gain, and the row text prints the number and gain. A solid line and a dashed line are told apart by the word in the row text as well as by the dash.
- move: the planner can plan it
- blocked move (dashed line): a dependency that stays behind holds it back
- review: a unit with no single target
- consumer of: a folder with a file that uses unit N
- 3 more moves are not drawn: the map draws the top 10.

**Against guidelines** (cognitive, each against its guideline. Guideline from a judgement call.)

| Item | cognitive | Guideline | Ratio | Position |
| --- | ---: | ---: | ---: | --- |
| f | 30 | 15 | 2x | above guideline |
| g | 10 | 15 | 0.67x | below guideline |

↑ stronger (support: 4 in 2024, 9 in 2025)

**Commits**

- `abc1234` Fix the parser (2025-03-01)
- `def5678` Fix again

_3 more not listed._

**Evidence**

| Measure | Value |
| --- | --- |
| Grade | weak |
| Months | 3.5 |

## Limits

- The sample is small.

**Judgement: limits**

Short history.
