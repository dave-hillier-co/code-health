# Knowledge report

- Repository: repo
- Analysed commit: `8b1b36a2426ea5a91dd5fd359f33f385e37741d6`
- Date: 2025-03-01
- Config hash: `0000000000000000`
- Evidence grade: weak
- History window: 25.7 months of usable history; the analysis window is 12 months, 2024-03-01 to 2025-03-01; authorship is the blame at the analysed commit
- Excluded:
  - commits outside the analysis window: 20
  - commits with no file left after filtering: 19

## Where knowledge is concentrated

**Judgement: where knowledge is concentrated**

Knowledge sits with a few people and the history is short.

## Knowledge-risk patterns

**Guidelines the patterns use (cochange.knowledge, each a judgement call that labels and orders files and hides none)**

| Measure | Value |
| --- | --- |
| singleOwnerShare | 90% of the lines held by people |
| formerContributorShare | 50% of the lines held by people |
| complexityPercentile | 50th percentile of complexity |
| manyActiveAuthors | 5 active developers |
| meaningfulShare | 5% of the lines held by people |
| inconclusiveShare | 50% of a file's lines |
| busFactorShare | 80% of the lines held by people |
| activityWindowMonths | 6 months without a commit means a developer has left |

**Files by knowledge-risk pattern**

| Pattern | Rule, with its guideline | Files, first pattern | Files, any pattern |
| --- | --- | ---: | ---: |
| Single-owner hotspot | One active developer holds at least 90% of the lines held by people, and the file is a hotspot | 1 | 1 |
| Complex code by former contributors | Developers who have left hold at least 50% of the lines held by people, and the file's complexity is at or above the 50th percentile | 3 | 3 |
| Single owner | One active developer holds at least 90% of the lines held by people | 2 | 3 |
| Many active developers | At least 5 active developers each hold at least 5% of the lines held by people | 0 | 0 |
| Inconclusive | Lines of bots, services, agents, unknown commits and unmapped identities are at least 50% of the file's lines, or its blame is not known | 1 | 1 |
| No pattern | None of the above applies | 1 | 1 |

**Files by lines held by people, marked by knowledge-risk pattern** (the items by lines held by people, largest first; marks: SOH Single-owner hotspot (1 tile); CFC Complex code by former contributors (3 tiles); SO Single owner (2 tiles); MAD Many active developers (0 tiles); INC Inconclusive (1 tile))

| Path | Size (lines held by people) | First pattern |
| --- | ---: | --- |
| src/api/auth.ts | 10 | Single-owner hotspot |
| src/api/routes.ts | 10 | none |
| src/core/engine.ts | 10 | Complex code by former contributors |
| src/core/lexer.ts | 10 | Complex code by former contributors |
| src/core/parser.ts | 10 | Complex code by former contributors |
| src/ui/view.ts | 10 | Single owner |
| src/util/log.ts | 10 | Single owner |
| src/gen/deps.ts | 5 | Inconclusive |

> **Notice:** The treemap draws the 8 production code files with the most lines held by people, of 8. The tables below list files of every kind by pattern, hottest first.

**Top files whose first pattern is single-owner hotspot, hottest first**

| # | File | Hotspot | Complexity | Lines held by people | Active holders | Former holders | Top active holder (%) | Held by former (%) | Bus factor |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | src/api/auth.ts | yes | 0 | 10 | 1 | 0 | 100 | 0 | 1 |

**Judgement: single-owner hotspot**

**Single-owner hotspot**: Verdict: pair. These files follow the pattern in the table above.

**Top files whose first pattern is complex code by former contributors, hottest first**

| # | File | Hotspot | Complexity | Lines held by people | Active holders | Former holders | Top active holder (%) | Held by former (%) | Bus factor |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | src/core/engine.ts | no | 0 | 10 | 0 | 1 | 0 | 100 | – |
| 2 | src/core/lexer.ts | no | 0 | 10 | 1 | 1 | 20 | 80 | – |
| 3 | src/core/parser.ts | no | 0 | 10 | 1 | 1 | 10 | 90 | – |

**Judgement: complex code by former contributors**

**Complex code by former contributors**: Verdict: pair. These files follow the pattern in the table above.

**Top files whose first pattern is single owner, hottest first**

| # | File | Hotspot | Complexity | Lines held by people | Active holders | Former holders | Top active holder (%) | Held by former (%) | Bus factor |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | src/ui/view.ts | no | 0 | 10 | 1 | 0 | 100 | 0 | 1 |
| 2 | src/util/log.ts | no | 0 | 10 | 1 | 0 | 100 | 0 | 1 |

**Judgement: single owner**

**Single owner**: Verdict: pair. These files follow the pattern in the table above.

**Top files whose first pattern is inconclusive, hottest first**

| # | File | Hotspot | Complexity | Lines held by people | Active holders | Former holders | Top active holder (%) | Held by former (%) | Bus factor |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | src/gen/deps.ts | no | 0 | 5 | 0 | 1 | 0 | 100 | – |

**Judgement: inconclusive**

**Inconclusive**: Verdict: map-identities. These files follow the pattern in the table above.

## Bus factor of the top hotspots

**Bus factor of the top hotspots: the fewest active developers who together hold 80% of a file's lines held by people**

| # | Hotspot | Hotspot score | Lines held by people | Active holders | Bus factor | Top active holder (%) | Held by former (%) | First pattern |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | src/api/auth.ts | 0.33 | 10 | 1 | 1 | 100 | 0 | Single-owner hotspot |
| 2 | src/api/routes.ts | 0.33 | 10 | 2 | 2 | 50 | 0 | – |

> **Notice:** A dash in the bus factor column means active developers together hold less than 80% of the file's lines held by people, so the rest sits with developers who have left or with lines nobody holds.

## Knowledge lost so far

**Knowledge lost so far, at the analysed commit**

| Measure | Value |
| --- | --- |
| Files with lines held by people | 8 |
| Files abandoned (90% or more of the lines held by people belong to people who have left) | 3 (37.5%) |
| Lines held by people | 75 |
| Of those, held by people who have left | 32 (42.7%) |
| Lines of bots, services and agents, on neither side | 5 |
| Lines with an unknown commit | 0 |
| Developers active, and who have left | 3 active, 2 left |

**Files with the most knowledge held by people who have left, ranked by abandoned share weighted by hotspot percentile**

| # | File | Held by former (%) | Lines lost | Lines held by people | Active holders | Former holders | Hotspot |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | src/core/engine.ts | 100 ▲ | 10 | 10 | 0 | 1 | no |
| 2 | src/core/lexer.ts | 80 | 8 | 10 | 1 | 1 | no |
| 3 | src/core/parser.ts | 90 | 9 | 10 | 1 | 1 | no |
| 4 | src/gen/deps.ts | 100 ▲ | 5 | 5 | 0 | 1 | no |

_Guidelines order and label the rows and decide nothing. Held by former (%) 90 (cochange.knowledge.abandonmentGuideline, at or above it a file is abandoned), ▲ marks a value above it._

> **Notice:** 4 of 8 measured files have no lines held by people who have left and are not listed.

## Simulated turnover

**Simulated turnover over 4 periods of 3 months, 300 trials, seed 1**

| Measure | Value |
| --- | --- |
| Model | rate; leaver rate per period 15% (configured) |
| Active developers | 3 |
| Files already abandoned | 3 of 8 |
| Expected further files lost | 2 (25.3% of files) |
| Knowledge at risk at the 95th percentile, in files | 5 of 8 files (62.5%), 2.5 times the expected loss |
| Knowledge at risk at the 99th percentile, in files | 5 of 8 files (62.5%), 2.5 times the expected loss |
| Expected further lines lost | 19.7 of 75 lines held by people (26.3%) |

**Files most likely to lose their authors within the horizon, hotspot-weighted**

| # | File | Probability (%) | Already abandoned | Hotspot | Active holders | Former holders | Findings |
| ---: | --- | ---: | --- | --- | ---: | ---: | --- |
| 1 | src/api/auth.ts | 43 ▲ | no | yes | 1 | 0 | at-risk-hot |
| 2 | src/api/routes.ts | 17.3 ▲ | no | yes | 2 | 0 | at-risk-hot |
| 3 | src/ui/view.ts | 52.7 ▲ | no | no | 1 | 0 | at-risk-cold, no-successor |
| 4 | src/core/engine.ts | 100 ▲ | yes | no | 0 | 1 | abandoned, no-successor |
| 5 | src/core/parser.ts | 100 ▲ | yes | no | 1 | 1 | abandoned, no-successor |
| 6 | src/gen/deps.ts | 100 ▲ | yes | no | 0 | 1 | abandoned, no-successor |
| 7 | src/core/lexer.ts | 44.7 ▲ | no | no | 1 | 1 | at-risk-cold, no-successor |
| 8 | src/util/log.ts | 44.7 ▲ | no | no | 1 | 0 | at-risk-cold, no-successor |

_Guidelines order and label the rows and decide nothing. Probability (%) 10 (cochange.knowledge.atRiskProbability), ▲ marks a value above it._

**Components by expected loss, with the tail ratio against its guideline**

| # | Component | Expected lines lost | Lines held by people | Tail ratio |
| ---: | --- | ---: | ---: | ---: |
| 1 | (unassigned) | 19.7 | 75 | 2.18 |

_Guidelines order and label the rows and decide nothing. Tail ratio 3 (cochange.knowledge.concentratedTailRatio), ▲ marks a value above it._

## Limits

- Guidelines order and label results. They are heuristics for investigation and decide nothing, and every file is listed under its pattern or under none.
- Authorship is git blame ignoring whitespace and following moved and copied lines. It says who last wrote a line, which is not who understands it.
- A developer counts as having left after 6 months without a commit. Someone on leave looks the same, and local overrides correct it.
- The simulation assumes turnover is random. It says nothing about any person, and the report names nobody unless run with --names, which lists active developers only.
- Each table shows the top 10 of its result and says how many rows it leaves out; `cochange abandonment patterns` prints every file.
- Complexity is the indentation proxy, because no `complexity files` result is stored for this commit. Test files and files that are not code have none, so the complex-code pattern does not apply to them (0 files with a blame have no complexity).
- The evidence grade is weak, so history-based results are tentative.

**Judgement: what limits these results**

Knowledge sits with a few people and the history is short.
