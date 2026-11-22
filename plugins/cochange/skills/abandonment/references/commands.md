# Abandonment commands

Invocation: `node ${CLAUDE_PLUGIN_ROOT}/dist/cochange.mjs <command> [options] --json` with the full path as the skill gives it. Options every command takes: `--limit N|all` (default 20, applies to list results), `--fields a,b`, and `--no-refresh` to read the caches as they are. Without it the history cache and the blame cache are refreshed first.

Exit codes: 0 success, 2 usage or config error (including `knowledge-disabled`), 3 environment error. With `--json`, errors are JSON on stderr.

Every document of `abandonment` and `successors` carries the history's `window`, `filtersApplied` and `evidence` (its grade says how far to trust anything history-based), `developers` (`active` and `inactive`, as counts) and `blame` (`unknownFiles`, the authored files the cache holds nothing right for, and `unattributedLines`). They are never stored as reports. Identities appear nowhere except `successors --names`.

## blame refresh

Brings the blame cache up to date: `git blame -w -M -C` of every authored file whose stored blame is missing or no longer right. Not behind the opt-in, because the cache holds commits and never people. Results: `head`, `files`, `blamed`, `reused`, `noText` (binary or empty files, remembered), `failed` (paths git could not blame), `pruned`, `rebuilt`, `aborted`. An interrupted run keeps what finished and the next run resumes.

## abandonment current [--by file|component] [--rank hotspot|abandonment]

Files with any lines held by people who have left. Rows: `path`, `abandoned` (the share is at or above `abandonmentGuideline`), `score`, `hotspot`, `hotspotPercentile`, `findings`, `abandonedShare`, `abandonedLines`, `peopleLines`, `activeAuthors`, `formerAuthors` (counts of people holding lines), `nonPersonLines`. `score` is the abandoned share times the hotspot percentile, or with `--rank abandonment` the abandoned lines. With `--by component`: `path`, `score`, `files`, `abandonedFiles`, `abandonedShare`, `abandonedLines`, `peopleLines`. The `summary` section gives the files and lines of the whole repository.

## abandonment turnover

One row per usable period: `start`, `end`, `developers` (on the team at its start), `departed`, `rate`. The `turnover` section pools them: `rate`, `atRisk`, `departed`, `periods`, and `configuredRate` when the config states one. Counts only.

## abandonment simulate [--mode rate|historical|k-leavers] [--k N] [--trials N] [--horizon P] [--seed S] [--rank R] [--top N]

`results`:

- `selection`: `source` (`history`, `configured` or `k-leavers`), `ratePerPeriod`, `leavers`, `leaverProbability` (the mean probability that an active developer leaves over the horizon).
- `population`: `activeDevelopers`, `files`, `peopleLines`.
- `loss.lines` and `loss.files`: `baseline` (already abandoned), `population`, and `increment` and `total`, each with `expected`, `expectedShare` and `atRisk`, one entry per alpha with `kar`, `karShare`, `tailRatio` and `expectedTailLoss`.
- `files`: the top N (default 20) by `score`, with `probability`, `tailShare`, `abandoned`, `hotspot`, `hotspotPercentile`, `peopleLines`, `activeAuthors`, `formerAuthors` and `findings`.
- `components`: per component `peopleLines`, `abandonedLines`, `expectedLoss` (increment in lines), `atRisk` and `findings`.

`--k` needs `--mode k-leavers` and cannot exceed the active developers. `--mode historical` needs at least one usable period and ignores a configured rate. Rate mode with no usable period and no configured rate stops and asks for one.

## successors PATH... [--names] [--top N]

One row per path: `abandoned`, `coupledFiles` (`path`, `degree`, `support`), `candidates` (active developers with a score), `noSuccessor`, and `successors` (the top N, default 5): `rank`, `score`, `coupledChanges`, `ownShare`, `evidence` (coupled files they changed, with `degree` and `changes`). `--names` adds `developer` to each. Only active developers are candidates.

## Configuration (`cochange.knowledge`)

`enabled` (false), `activityWindowMonths` (6), `periodMonths` (3), `horizonPeriods` (4), `abandonmentGuideline` (90), `turnoverRate` (null, a percentage per period), `trials` (10000), `alphas` ([95, 99]), `seed` (1), `rank` (`hotspot`), `copyDetection` (true), `atRiskProbability` (10), `concentratedTailRatio` (3).

Local, never committed: `.code-health/local/knowledge-overrides.json`, `{ "schemaVersion": 1, "active": ["Name <email>"], "inactive": ["Name <email>"] }`.
