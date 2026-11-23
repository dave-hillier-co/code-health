# Code health overview

- Repository: repo
- Analysed commit: `9f65c10e2680360c26e94d73aa12fc4b81bdd0dc`
- Date: 2024-06-01
- Config hash: `0000000000000000`
- Evidence grade: weak
- History window: 4.7 months of usable history; the analysis window is 12 months, 2023-06-01 to 2024-06-01
- Excluded:
  - non-code files left out of the rankings: 1
  - test files left out of the rankings: 1

## What to look at first

**Judgement: where to start**

1. **src/billing/invoice.ts (hotspot ranking)** (verdict: investigate-first): It tops the ranking, and it is the file the fixes touched.
2. **src/reporting/summary.ts (hotspot ranking)** (verdict: worth-a-look): It tops the ranking, and it is the file the fixes touched.

## Evidence

**Evidence behind the history-based results**

| Measure | Value |
| --- | --- |
| Evidence grade | weak |
| Months of usable history | 4.7 |
| Active contributors in the window | 2 |
| Logical changes in the window | 6 |
| Shallow clone | no |
| Imported history | none detected |
| Merge policy | no shift in the median files per change (2 earlier, 1 later) |

**History against the guidelines for strong evidence** (percent of the guideline for strong evidence, each against its guideline. Guidelines for strong evidence: 24 months, 300 logical changes, 5 contributors.)

| Item | percent of the guideline for strong evidence | Guideline | Ratio | Position |
| --- | ---: | ---: | ---: | --- |
| Months of history (4.7 of 24) | 19.58 | 100 | 0.2x | below guideline |
| Logical changes (6 of 300) | 2 | 100 | 0.02x | below guideline |
| Contributors (2 of 5) | 40 | 100 | 0.4x | below guideline |

↓ weaker (Median files per logical change: 2 in the earlier half, 1 in the later half)

## Fix convention

**Fix convention check**

| Measure | Value |
| --- | --- |
| Landed changes in the window | 6 |
| Changes whose title or message is a fix | 0 (0%) |
| Conventional Commits fix prefixes | 0 |
| Fix verbs | 0 |
| Issue references | 0 |
| Convention followed | no |

> **Notice:** The commit messages probably do not follow a convention this can use: none of the 6 landed changes uses a recognisable fix form (a Conventional Commits type, a leading Fix or Fixes, or an issue reference).

## What was excluded

**What the run left out, with counts**

| Left out | Count |
| --- | ---: |
| commits outside the analysis window | 0 |
| shallow boundary commits | 0 |
| commits of imported history | 0 |
| commits in the blame ignore file | 0 |
| commits by bots and service accounts | 0 |
| commits trailed by this suite | 0 |
| commits with no file left after filtering | 0 |
| file changes that only rename | 0 |
| file changes matching exclude globs | 0 |
| lockfile changes | 0 |
| generated file changes | 0 |
| vendored file changes | 0 |
| changes over the changeset limit of 30 files | 0 |
| non-code files left out of the rankings | 1 |
| test files left out of the rankings | 1 |

## Top results of each plugin

**Highest hotspot scores, from cochange hotspots**

| # | File | Score | Revisions | Complexity | Fixes | Flag |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | src/billing/invoice.ts | 0.38 | 4 | 0 | 0 | hotspot |
| 2 | src/reporting/summary.ts | 0.13 | 3 | 0 | 0 | – |

**Distribution of hotspot scores** (files per bin)

| Bin | Count (files) | Share |
| --- | ---: | ---: |
| 0.0 to 0.1 | 0 | 0% |
| 0.1 to 0.2 | 1 | 50% |
| 0.2 to 0.3 | 0 | 0% |
| 0.3 to 0.4 | 1 | 50% |
| 0.4 to 0.5 | 0 | 0% |
| 0.5 to 0.6 | 0 | 0% |
| 0.6 to 0.7 | 0 | 0% |
| 0.7 to 0.8 | 0 | 0% |
| 0.8 to 0.9 | 0 | 0% |
| 0.9 to 1.0 | 0 | 0% |

> **Notice:** No stored complexity analyse result for this commit. Run `complexity analyse` to store it, then run the overview again.

> **Notice:** No stored structure cycles result for this commit. Run `structure cycles` to store it, then run the overview again.

> **Notice:** No stored locality analyse result for this commit. Run `locality analyse` to store it, then run the overview again.

## Limits

- Guidelines order and label results. They are heuristics for investigation and decide nothing.
- Each table shows the top 5 of its result and says how many rows it leaves out; the command prints the rest.
- The evidence grade is weak, so history-based results are tentative and static signals should lead.
- Hotspot complexity is the indentation proxy, because no complexity report covers this commit.
- Not stored for this commit: complexity analyse, structure cycles, locality analyse. The overview reads other plugins' stored results and never computes them.

**Judgement: what limits these results**

One contributor wrote all of it, so the history says little about ownership.
