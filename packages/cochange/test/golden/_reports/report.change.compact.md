# Change summary a8315dd..d9e6630 (1 commit, 1 file)

- Repository `repo` at `a8315ddcd7fd` on 2024-05-06; config hash `0000000000000000`
- Evidence grade: weak. History window: 5 months of usable history; the baseline is the 16 merged changes since 2023-06-07
- Excluded: nothing

## Needs attention

**Judgement: missing-co-change**

1. **2 files that usually change with the touched files are not in the change: src/billing/invoice.test.ts, src/billing/tax.ts** (verdict: accepted-with-reason): The author's reason is the one the history supports.

**Judgement: test-evidence**

1. **1 source file changed without the tests that usually change with it, or tests deleted: src/billing/invoice.ts** (verdict: accepted-with-reason): The author's reason is the one the history supports.

**Judgement: new import cycle cycle:src/billing+src/reports**

1. **new import cycle cycle:src/billing+src/reports: 2 modules at the folder level: src/billing, src/reports** (verdict: accepted-with-reason): The author's reason is the one the history supports.

**Judgement: new layer violation src/billing/invoice.ts-\>src/reports/summary.ts**

1. **new layer violation src/billing/invoice.ts-\>src/reports/summary.ts: domain imports reporting** (verdict: accepted-with-reason): The author's reason is the one the history supports.

**Judgement: complexity of src/billing/invoice.ts#total**

1. **src/billing/invoice.ts#total (worsened): cognitive 18 to 27 (guideline 15)** (verdict: accepted-with-reason): The author's reason is the one the history supports.

**Judgement: complexity of src/billing/tax.ts#surcharge**

1. **src/billing/tax.ts#surcharge (new): cognitive 22 (guideline 15)** (verdict: accepted-with-reason): The author's reason is the one the history supports.

## Reviewer guidance

**Judgement: reviewer guidance**

1. **the change**: Open the files the tables name first, then ask the author about each item.

## Limits

- Guidelines order and label what is shown. They are heuristics for review and decide nothing.
- The evidence grade is weak, so the history-based bands are tentative and the static results should lead.
- No band for defect-history, abandoned-touched: the factor could not be computed.

**Judgement: what limits this summary**

1. **the change**: Open the files the tables name first, then ask the author about each item.
