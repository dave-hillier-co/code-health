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

**Functions of src/billing.ts by cognitive complexity** (cognitive complexity against a guideline of 15, with revisions and fixes. The guideline is complexity.guidelines, the warn level. Revisions and fixes count landed changes in the history window.)

| Function | cognitive complexity | Guideline | Position | Revisions | Fixes |
| --- | ---: | ---: | --- | ---: | ---: |
| priceOrder | 8 | 15 | below guideline | 5 | 2 |
| describe | 1 | 15 | below guideline | 2 | 1 |

**Changes shared by the most changed functions of src/billing.ts** (shared changes; band 1: 1)

|  | priceOrder | describe |
| --- | ---: | ---: |
| priceOrder | none | 1 |
| describe | 1 | none |

Rows and columns are the 2 functions with the most revisions (at least 2), most first. A cell is the number of landed changes in the window that touched both functions; the diagonal is empty.

**Judgement: the file as a whole**

**src/billing.ts**: The pricing function holds most of the complexity and most of the fixes.

## X-Ray

**X-Ray of src/billing.ts: its functions, most complex first**

| # | Function | Lines | Length | Cognitive | Nesting | Cyclomatic | Revisions | Fixes | Code smells |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | priceOrder | 4-14 | 11 | 8 | 2 | 5 | 5 | 2 | none |
| 2 | describe | 16-22 | 7 | 1 | 1 | 2 | 2 | 1 | none |

_Guidelines order and label the rows and decide nothing. Cognitive 15 (complexity.guidelines, the warn level), ▲ marks a value above it; Nesting 4 (complexity.guidelines, the warn level), ▲ marks a value above it; Cyclomatic 10 (complexity.guidelines, the warn level), ▲ marks a value above it._

**Judgement: priceOrder**

**priceOrder (src/billing.ts, lines 4-14)**: Verdict: nonobvious-code. It is long and has been fixed more than once.

**Judgement: describe**

**describe (src/billing.ts, lines 16-22)**: Verdict: nonobvious-code. It is long and has been fixed more than once.

## Limits

- Guidelines order and label results. They are heuristics for investigation and decide nothing.
- The table lists every function of the file, sorted by cognitive complexity, then cyclomatic complexity, highest first. Length has no guideline: a long, linear function is often clearer than five shallow fragments.
- Revisions and fixes are counts of landed changes in the window that touched the function, and a fix is a count of commit messages, not of defects.
- Only the first 2 functions have a judgement, because the table is ordered by cognitive complexity.

**Judgement: what limits these results**

The pricing function holds most of the complexity and most of the fixes.
