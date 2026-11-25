# Change summary a8315dd..d9e6630

- Repository: repo
- Analysed commit: `a8315ddcd7fd55944a8c26867938cd8591afee71`
- Date: 2024-05-06
- Config hash: `0000000000000000`
- Evidence grade: weak
- History window: 5 months of usable history; the baseline is the 16 merged changes since 2023-06-07
- Excluded: nothing

## The change

**The change**

| Measure | Value |
| --- | --- |
| Range | a8315dd..d9e6630, against main |
| Commits | 1 |
| Files changed | 1 |
| Lines added and deleted | 20 and 20 |
| Files moved or renamed | 0 |
| Commits with an agent trailer | 0 |

**Change footprint: 1 changed file against 3 files** (shared changes of the row file and the column file in the analysis window; band 1: 6)

| Row | Column | Value | Mark |
| --- | --- | ---: | --- |
| ...illing/invoice.ts | ...g/invoice.test.ts | 6 | a usual partner of the row file that the change left out, as listed under Missing co-change partners |
| ...illing/invoice.ts | src/billing/tax.ts | 6 | a usual partner of the row file that the change left out, as listed under Missing co-change partners |

The table lists the cells that have a value or a mark, in row order then column order. Blank cells have no value (1 cell of 3 cells). ! is a usual partner of the row file that the change left out, as listed under Missing co-change partners (2 cells). Columns are the changed files, then the missing partners. Rows are ordered by missing partners, then by partners in the change, then by path. Missing columns follow the order of the Missing co-change partners section, and each is marked at the file it usually changes with.

## Reviewer guidance

**Judgement: reviewer guidance**

Open the files the tables name first, then ask the author about each item.

## Needs attention

**missing-co-change (moderate): 2 files that usually change with the touched files are not in the change**

- `src/billing/invoice.test.ts` towards src/billing/invoice.ts, confidence 85.7, support 6
- `src/billing/tax.ts` towards src/billing/invoice.ts, confidence 85.7, support 6

**Judgement: missing-co-change**

**2 files that usually change with the touched files are not in the change: src/billing/invoice.test.ts, src/billing/tax.ts**: Verdict: accepted-with-reason. The author's reason is the one the history supports.

**test-evidence (moderate): 1 source file changed without the tests that usually change with it, or tests deleted**

- `src/billing/invoice.ts` test src/billing/invoice.test.ts, kind not-updated, together 6, revisions 7

**Judgement: test-evidence**

**1 source file changed without the tests that usually change with it, or tests deleted: src/billing/invoice.ts**: Verdict: accepted-with-reason. The author's reason is the one the history supports.

**new import cycle: cycle:src/billing+src/reports**

- `cycle:src/billing+src/reports` 2 modules at the folder level: src/billing, src/reports

**Judgement: new import cycle cycle:src/billing+src/reports**

**new import cycle cycle:src/billing+src/reports: 2 modules at the folder level: src/billing, src/reports**: Verdict: accepted-with-reason. The author's reason is the one the history supports.

**new layer violation: src/billing/invoice.ts-\>src/reports/summary.ts**

- `src/billing/invoice.ts->src/reports/summary.ts` domain imports reporting

**Judgement: new layer violation src/billing/invoice.ts-\>src/reports/summary.ts**

**new layer violation src/billing/invoice.ts-\>src/reports/summary.ts: domain imports reporting**: Verdict: accepted-with-reason. The author's reason is the one the history supports.

**src/billing/invoice.ts#total: existing function above guideline that got worse**

- `cognitive` worsened: before 18, after 27, guideline 15

**Judgement: complexity of src/billing/invoice.ts#total**

**src/billing/invoice.ts#total (worsened): cognitive 18 to 27 (guideline 15)**: Verdict: accepted-with-reason. The author's reason is the one the history supports.

**src/billing/tax.ts#surcharge: new function above guideline**

- `cognitive` new function: after 22, guideline 15

**Judgement: complexity of src/billing/tax.ts#surcharge**

**src/billing/tax.ts#surcharge (new): cognitive 22 (guideline 15)**: Verdict: accepted-with-reason. The author's reason is the one the history supports.

## Risk factors

Each band compares the change with the 16 merged changes measured as of their own time since 2023-06-07, and counts are met from a stated value. A band labels the value beside it and decides nothing.

**Risk factors with their values and bands**

| Factor | Band | Value | Guideline | Evidence items |
| --- | --- | --- | --- | ---: |
| size | low | lines 40, files 1 | lines: above 80 is high, with no moderate band: the moderate and high cutoffs are the same value | 0 |
| spread | low | spread 0, folders 1 | spread: above 0 is high, with no moderate band: the moderate and high cutoffs are the same value | 0 |
| entropy | low | entropy 0, filesWithLineChanges 1 | entropy: above 1.5 is high, with no moderate band: the moderate and high cutoffs are the same value | 0 |
| mixed-purpose | low | moved 0, edited 1, editedWhileMoved 0 | count: moderate from 1, high from 3 | 0 |
| hotspots-touched | low | share 1, hotFiles 1 | share: above 1 is high, with no moderate band: the moderate and high cutoffs are the same value | 1 |
| defect-history | unavailable | share 0.142857, fixes 1, revisions 7 | share: no cutoff, the baseline is too small | 1 |
| contention | low | authors 0 | authors: moderate above 0, high above 1 | 0 |
| age | low | stale 0, settling 0, known 1 | stale: above 0 is high, with no moderate band: the moderate and high cutoffs are the same value; settling: above 0 is high, with no moderate band: the moderate and high cutoffs are the same value | 0 |
| missing-co-change | moderate | count 2 | count: moderate from 1, high from 3 | 2 |
| novel-coupling | low | count 0 | count: moderate from 1, high from 3 | 0 |
| test-evidence | moderate | count 1 | count: moderate from 1, high from 3 | 1 |
| blast-radius | moderate | files 2, signatureChanges 0, symbolFanIn 0, symbolFanInUnresolved 0 | files: moderate above 0, high above 2 | 2 |
| sensitive-paths | low | count 0 | count: moderate from 1, high from 3 | 0 |
| complexity-delta | low | indentation proxy, not a complexity comparison: count 0, files 1, newFiles 0 | count: moderate from 1, high from 3 | 0 |
| structure-delta | moderate | count 2 | count: moderate from 1, high from 3 | 2 |
| abandoned-touched | unavailable | none | none | 0 |

**Factors with no band**

- `defect-history` unavailable: fewer than 10 merged changes in the baseline, so a value of 0.142857 cannot be placed
- `abandoned-touched` unavailable: knowledge analysis is not enabled (cochange.knowledge.enabled)

> **Notice:** No level is shown: a level is shown only where a stored backtest shows that the levels separate past changes, and none is stored for this configuration.

## Missing co-change partners

**Files that usually change with a touched file and are not in the change**

| # | Missing file | Usually changes with | Confidence (%) | Shared changes |
| ---: | --- | --- | ---: | ---: |
| 1 | src/billing/invoice.test.ts | src/billing/invoice.ts | 85.7 | 6 |
| 2 | src/billing/tax.ts | src/billing/invoice.ts | 85.7 | 6 |

_Guidelines order and label the rows and decide nothing. Confidence (%) 80 (cochange.risk.missingConfidence), ▼ marks a value below it; Shared changes 5 (cochange.minSupport), ▼ marks a value below it._

## Complexity before and after

**Functions above a complexity guideline that are new or got worse, from complexity check**

| Function | Metric | Change | Before | After | Guideline | Against the guideline |
| --- | --- | --- | ---: | ---: | ---: | --- |
| src/billing/invoice.ts#total | cognitive | worsened | 18 | 27 | 15 | above guideline by 12 |
| src/billing/tax.ts#surcharge | cognitive | new | – | 22 | 15 | above guideline by 7 |

> **Limit:** 1 changed file could not be parsed, so its functions were not compared.

## Structure findings the change adds

**Import cycles and layer violations the change adds, from structure check**

| Kind | Finding | Detail |
| --- | --- | --- |
| cycle | cycle:src/billing+src/reports | 2 modules at the folder level: src/billing, src/reports |
| layer-violation | src/billing/invoice.ts-\>src/reports/summary.ts | domain imports reporting |

## Hotspots touched

**Hotspots the change touches**

| Measure | Value |
| --- | --- |
| Hot files touched | 1 |
| Share of the change's churn in hot files | 100% |
| Band | low |
| Guideline | share: above 1 is high, with no moderate band: the moderate and high cutoffs are the same value |

**Hot files the change touches, by revisions in the window ending at the base commit (the change itself is not counted)**

| # | File | Revisions |
| ---: | --- | ---: |
| 1 | src/billing/invoice.ts | 7 |

## Abandoned files touched

> **Notice:** Abandoned touched files could not be computed: knowledge analysis is not enabled (cochange.knowledge.enabled).

## Evidence behind the factors

**Evidence for hotspots-touched**

- `src/billing/invoice.ts` revisions 7

**Evidence for missing-co-change**

- `src/billing/invoice.test.ts` towards src/billing/invoice.ts, confidence 85.7, support 6
- `src/billing/tax.ts` towards src/billing/invoice.ts, confidence 85.7, support 6

**Evidence for test-evidence**

- `src/billing/invoice.ts` test src/billing/invoice.test.ts, kind not-updated, together 6, revisions 7

**Evidence for blast-radius**

- `src/billing/invoice.test.ts` towards src/billing/invoice.ts, confidence 85.7
- `src/billing/tax.ts` towards src/billing/invoice.ts, confidence 85.7

**Evidence for structure-delta**

- `cycle:src/billing+src/reports` kind cycle
- `src/billing/invoice.ts->src/reports/summary.ts` kind layer-violation

## Limits

- Guidelines order and label what is shown. They are heuristics for review and decide nothing.
- The evidence grade is weak, so the history-based bands are tentative and the static results should lead.
- No band for defect-history, abandoned-touched: the factor could not be computed.
- No level is shown, because no stored backtest of this repository says the levels separate past changes.
- Who wrote the touched code (placement) is about people, so this report leaves it out. Names of people appear nowhere on this page.

**Judgement: what limits this summary**

Open the files the tables name first, then ask the author about each item.
