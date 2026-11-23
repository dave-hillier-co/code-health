# X-Ray of src/billing.ts

- Repository: repo
- Analysed commit: `ff3b4208d8631f234e71c3f979954c0eb2989f9e`
- Date: 2024-02-11
- Config hash: `0000000000000000`
- Evidence grade: weak
- History window: 12 months of fix history, 2023-02-11 to 2024-02-11
- Excluded: nothing

## Summary

**Measures of src/billing.ts**

| Measure | Value |
| --- | --- |
| Functions measured | 2 |
| Functions with a code smell label | 0 |
| Functions changed in the window | 2 |
| Commits analysed | 11 of 11 in the window |

**Judgement: the file as a whole**

1. **src/billing.ts**: The pricing function holds most of the complexity and most of the fixes.

## X-Ray

**X-Ray of src/billing.ts: its functions, most complex first**

| # | Function | Lines | Length | Cognitive | Nesting | Cyclomatic | Revisions | Fixes | Code smells |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | priceOrder | 4-14 | 11 | 8 | 2 | 5 | 5 | 2 | none |
| 2 | describe | 16-22 | 7 | 1 | 1 | 2 | 2 | 1 | none |

_Guidelines order and label the rows and decide nothing. Cognitive 15 (complexity.guidelines, the warn level), ▲ marks a value above it; Nesting 4 (complexity.guidelines, the warn level), ▲ marks a value above it; Cyclomatic 10 (complexity.guidelines, the warn level), ▲ marks a value above it._

**Judgement: priceOrder**

1. **priceOrder (src/billing.ts, lines 4-14)** (verdict: nonobvious-code): It is long and has been fixed more than once.

**Judgement: describe**

1. **describe (src/billing.ts, lines 16-22)** (verdict: nonobvious-code): It is long and has been fixed more than once.

## Limits

- Guidelines order and label results. They are heuristics for investigation and decide nothing.
- The table lists every function of the file. Length has no guideline: a long, linear function is often clearer than five shallow fragments.
- Revisions and fixes are counts of landed changes in the window that touched the function, and a fix is a count of commit messages, not of defects.
- Only the first 2 functions have a judgement, because the table is ordered by cognitive complexity.

**Judgement: what limits these results**

1. **src/billing.ts**: The pricing function holds most of the complexity and most of the fixes.
