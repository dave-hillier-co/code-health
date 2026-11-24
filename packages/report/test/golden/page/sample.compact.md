# Sample report

- Repository `demo` at `0123456789ab` on 2025-06-01; config hash `abcdef0123456789`
- Evidence grade: moderate. History window: 8 months of history
- Excluded: 3 in total across 1 kind; the full report lists each

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

**Files by lines and revisions** (the items by lines, largest first; band is revisions, band 1: 1, band 2: 3, band 3: 7, band 4: 12)

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

**Shared changes** (shared changes; band 1: 1, band 2: 5, band 3: 9)

|  | a.ts | b.ts | c.ts |
| --- | ---: | ---: | ---: |
| a.ts | none | 5 | 1 |
| b.ts | 5 | none | 9 |

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
