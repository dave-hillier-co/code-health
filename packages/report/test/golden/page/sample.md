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

**Functions by cognitive complexity** (cognitive complexity against a guideline of 15, with revisions and fixes. Guideline from a judgement call.)

| Function | cognitive complexity | Guideline | Position | Revisions | Fixes |
| --- | ---: | ---: | --- | ---: | ---: |
| parse | 30 | 15 | above guideline | 12 | 4 |
| format | 10 | 15 | below guideline | 3 | 0 |
| plain | 5 | 15 | below guideline | none | none |

The chart omits 2 functions: the least complex of the file.

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
