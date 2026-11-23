# Locality report

- Repository: repo
- Analysed commit: `78ddadd4de155734ef2b56a253b72b25b5f87053`
- Date: 2025-01-01
- Config hash: `0000000000000000`
- Evidence grade: weak
- History window: 12 months of usable history; the analysis window is 12 months, 2024-01-01 to 2025-01-01
- Excluded:
  - units already beside their consumers (rule near-consumers): 16
  - units recommended blocked, held back by a dependency (listed below with their blockers): 3

## Summary

**Judgement: what this report says**

1. **the repository**: The helpers sit far from their consumers.

## Candidates

**What the analysis covered**

| Measure | Value |
| --- | --- |
| Files analysed | 31 |
| Units | 30 |
| Candidates of kind move, split, inline, scrutinise or review | 11 |
| Recommended blocked | 3 |
| Recommended inline | 3 |
| Recommended move | 5 |
| Recommended review | 1 |
| Recommended scrutinise | 1 |
| Recommended split | 1 |

**Candidates, ordered by gain over the locality.minDistance guideline**

| # | Unit | Kind | Gain (net distance removed) | Gain over guideline | Consumer files | Consumer folders | Distance | Confidence |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | src/shared/helpers/mixed.ts | split | 4 ▲ | 3 | 2 | 2 | 2 | normal |
| 2 | src/shared/pair | move | 6 ▲ | 3 | 2 | 1 | 3 | normal |
| 3 | src/shared/utils/money.ts | move | 4 ▲ | 2 | 2 | 2 | 2 | normal |
| 4 | src/shared/cycle/a.ts | move | 3 ▲ | 1.5 | 1 | 1 | 3 | normal |
| 5 | src/shared/utils/invoice.ts | move | 3 ▲ | 1.5 | 1 | 1 | 3 | normal |
| 6 | src/shared/utils/slug.ts | inline | 3 ▲ | 1.5 | 1 | 1 | 3 | normal |
| 7 | src/shared/format.ts | scrutinise | 16 ▲ | 1 | 8 | 1 | 2 | normal |
| 8 | src/orders/place.ts | review | 2 | 1 | 1 | 1 | 1 | normal |
| 9 | src/shared/log.ts | move | 2 | 1 | 2 | 2 | 1 | normal |
| 10 | src/billing/index.ts | inline | 0 | 0 | 0 | 0 | 0 | normal |
| 11 | src/orders/audit.ts | inline | 0 | 0 | 1 | 1 | 0 | normal |

_Guidelines order and label the rows and decide nothing. Gain (net distance removed) 2 (locality.minDistance), ▲ marks a value above it._

## 1. src/shared/helpers/mixed.ts

**Candidate 1: src/shared/helpers/mixed.ts**

| Measure | Value |
| --- | --- |
| Kind | split (rule mixed-exports) |
| Reason | Exports with disjoint consumers in different folders: split the file. `locality move` needs --reason for a split. |
| Gain | 4 of net distance removed, against the locality.minDistance guideline of 2 |
| Net distance | 6 now, 2 at the target src |
| Consumers | 2 files in 2 folders |
| Size | 1 file, 6 lines |
| Confidence | normal |
| Blockers | none |
| Move plan (dry run) | no plan: needs-reason; first: the analyser recommends split (mixed-exports), not a move: pass --reason to record why it moves anyway |

**Judgement: src/shared/helpers/mixed.ts**

1. **src/shared/helpers/mixed.ts** (verdict: do-it): It has few consumers and nothing blocks it. Risk: a missed consumer.

## 2. src/shared/pair

**Candidate 2: src/shared/pair**

| Measure | Value |
| --- | --- |
| Kind | move (rule two-consumers) |
| Reason | Two consumers: move to the target. |
| Gain | 6 of net distance removed, against the locality.minDistance guideline of 2 |
| Net distance | 6 now, 0 at the target src/reports |
| Consumers | 2 files in 1 folder |
| Size | 3 files, 11 lines |
| Confidence | normal |
| Blockers | none |
| Move plan (dry run) | 3 files moved to src/reports, 2 imports rewritten in 2 files |

**Judgement: src/shared/pair**

1. **src/shared/pair** (verdict: do-it): It has few consumers and nothing blocks it. Risk: a missed consumer.

## 3. src/shared/utils/money.ts

**Candidate 3: src/shared/utils/money.ts**

| Measure | Value |
| --- | --- |
| Kind | move (rule two-consumers) |
| Reason | Two consumers: move to the target. |
| Gain | 4 of net distance removed, against the locality.minDistance guideline of 2 |
| Net distance | 6 now, 2 at the target src |
| Consumers | 2 files in 2 folders |
| Size | 1 file, 6 lines |
| Confidence | normal |
| Blockers | none |
| Move plan (dry run) | 1 file moved to src, 3 imports rewritten in 3 files |

**Judgement: src/shared/utils/money.ts**

1. **src/shared/utils/money.ts** (verdict: do-it): It has few consumers and nothing blocks it. Risk: a missed consumer.

## 4. src/shared/cycle/a.ts

**Candidate 4: src/shared/cycle/a.ts**

| Measure | Value |
| --- | --- |
| Kind | move (rule single-consumer-tiny) |
| Reason | One consumer, and the unit is tiny: inline it. |
| Gain | 3 of net distance removed, against the locality.minDistance guideline of 2 |
| Net distance | 3 now, 0 at the target src/orders |
| Consumers | 1 file in 1 folder |
| Size | 2 files, 8 lines |
| Confidence | normal |
| Blockers | none |
| Move plan (dry run) | 2 files moved to src/orders, 1 import rewritten in 1 file |

**Judgement: src/shared/cycle/a.ts**

1. **src/shared/cycle/a.ts** (verdict: do-it): It has few consumers and nothing blocks it. Risk: a missed consumer.

## 5. src/shared/utils/invoice.ts

**Candidate 5: src/shared/utils/invoice.ts**

| Measure | Value |
| --- | --- |
| Kind | move (rule single-consumer-large) |
| Reason | One consumer and a large unit: move it next to the consumer, as its own module. |
| Gain | 3 of net distance removed, against the locality.minDistance guideline of 2 |
| Net distance | 3 now, 0 at the target src/billing |
| Consumers | 1 file in 1 folder |
| Size | 1 file, 164 lines |
| Confidence | normal |
| Blockers | none |
| Move plan (dry run) | 1 file moved to src/billing, 1 import rewritten in 1 file |

**Judgement: src/shared/utils/invoice.ts**

1. **src/shared/utils/invoice.ts** (verdict: do-it): It has few consumers and nothing blocks it. Risk: a missed consumer.

## 6. src/shared/utils/slug.ts

**Candidate 6: src/shared/utils/slug.ts**

| Measure | Value |
| --- | --- |
| Kind | inline (rule single-consumer-tiny) |
| Reason | One consumer, and the unit is tiny: inline it. |
| Gain | 3 of net distance removed, against the locality.minDistance guideline of 2 |
| Net distance | 3 now, 0 at the target src/orders |
| Consumers | 1 file in 1 folder |
| Size | 1 file, 3 lines |
| Confidence | normal |
| Blockers | none |
| Move plan (dry run) | no plan: needs-reason; first: the analyser recommends inline (single-consumer-tiny), not a move: pass --reason to record why it moves anyway |

**Judgement: src/shared/utils/slug.ts**

1. **src/shared/utils/slug.ts** (verdict: do-it): It has few consumers and nothing blocks it. Risk: a missed consumer.

## 7. src/shared/format.ts

**Candidate 7: src/shared/format.ts**

| Measure | Value |
| --- | --- |
| Kind | scrutinise (rule high-fan-in) |
| Reason | Fan-in at or above the locality.highFanIn guideline: the location looks earned, so review the design. `locality move` needs --reason for a scrutinise. |
| Gain | 16 of net distance removed, against the locality.minDistance guideline of 2 |
| Net distance | 16 now, 0 at the target src/features |
| Consumers | 8 files in 1 folder |
| Size | 1 file, 3 lines |
| Confidence | normal |
| Blockers | none |
| Move plan (dry run) | no plan: needs-reason; first: the analyser recommends scrutinise (high-fan-in), not a move: pass --reason to record why it moves anyway |

**Judgement: src/shared/format.ts**

1. **src/shared/format.ts** (verdict: do-it): It has few consumers and nothing blocks it. Risk: a missed consumer.

## 8. src/orders/place.ts

**Candidate 8: src/orders/place.ts**

| Measure | Value |
| --- | --- |
| Kind | review (rule scattered-unit) |
| Reason | Guard: the unit's files live outside its entry file's folder, so its leaves are scored on their own. `locality move` needs --reason for a review. |
| Gain | 2 of net distance removed, against the locality.minDistance guideline of 2 |
| Net distance | 9 now, 7 at the target src/shared |
| Consumers | 1 file in 1 folder |
| Size | 5 files, 23 lines |
| Confidence | normal |
| Blockers | none |
| Move plan (dry run) | no plan: needs-reason; first: the analyser recommends review (scattered-unit), not a move: pass --reason to record why it moves anyway |

**Judgement: src/orders/place.ts**

1. **src/orders/place.ts** (verdict: do-it): It has few consumers and nothing blocks it. Risk: a missed consumer.

## 9. src/shared/log.ts

**Candidate 9: src/shared/log.ts**

| Measure | Value |
| --- | --- |
| Kind | move (rule two-consumers) |
| Reason | Two consumers: move to the target. |
| Gain | 2 of net distance removed, against the locality.minDistance guideline of 2 |
| Net distance | 4 now, 2 at the target src |
| Consumers | 2 files in 2 folders |
| Size | 1 file, 3 lines |
| Confidence | normal |
| Blockers | none |
| Move plan (dry run) | 1 file moved to src, 2 imports rewritten in 2 files |

**Judgement: src/shared/log.ts**

1. **src/shared/log.ts** (verdict: do-it): It has few consumers and nothing blocks it. Risk: a missed consumer.

## 10. src/billing/index.ts

**Candidate 10: src/billing/index.ts**

| Measure | Value |
| --- | --- |
| Kind | inline (rule single-consumer-barrel) |
| Reason | A barrel with one importing file: inline it by rewriting imports to the real definitions. |
| Gain | 0 of net distance removed, against the locality.minDistance guideline of 2 |
| Net distance | 0 now, 0 at the target src/billing |
| Consumers | 0 files in 0 folders |
| Size | 1 file, 1 line |
| Confidence | normal |
| Blockers | none |
| Move plan (dry run) | no plan: barrel; first: a barrel is inlined by rewriting its importer to the real definitions, not moved |

**Judgement: src/billing/index.ts**

1. **src/billing/index.ts** (verdict: do-it): It has few consumers and nothing blocks it. Risk: a missed consumer.

## Consumer distance

**Distance from each unit's folder to its consumers' folders, in folder hops** (unit and consumer file pairs per bin)

| Bin | Count (unit and consumer file pairs) | Share |
| --- | ---: | ---: |
| 0 | 2 | 8.33% |
| 1 | 0 | 0% |
| 2 | 10 | 41.67% |
| 3 | 11 | 45.83% |
| 4 | 1 | 4.17% |
| 5 or more | 0 | 0% |

## Unresolved imports

> **Notice:** Every import the analysis read resolved, so no consumer is missing for that reason.

## Omitted, by reason

**What the analysis and this report left out, by reason**

| Left out | Count |
| --- | ---: |
| units already beside their consumers (rule near-consumers) | 16 |
| units recommended blocked, held back by a dependency (listed below with their blockers) | 3 |

> **Notice:** No unit was left without a proposed move.

**Units recommended blocked, with the files that hold them back**

| # | Unit | Gain | Blockers |
| ---: | --- | ---: | --- |
| 1 | src/lib/kernel/tool.ts | 0 | src/lib/kernel/core.ts |
| 2 | src/shared/pair/a.ts | 0 | src/shared/pair/core.ts |
| 3 | src/shared/pair/b.ts | 0 | src/shared/pair/core.ts |

> **Notice:** The history counts are zero because history is weak (12 months, 34 logical changes in the window, 1 contributors); history-only candidates need moderate or strong evidence.

## Limits

- Guidelines order and label results. They are heuristics for investigation and decide nothing.
- The table shows the top 15 candidates and says how many it leaves out; the move plans and judgements cover the top 10.
- A move plan is a dry run of the proposed move. The report never applies one.
- Gain is the net distance a move removes, against the locality.minDistance guideline. It does not say the move is worth its churn.
- The evidence grade is weak, so history-based evidence is tentative and the structure leads.

**Judgement: what limits these results**

1. **the repository**: The helpers sit far from their consumers.
