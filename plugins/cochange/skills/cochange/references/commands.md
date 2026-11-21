# cochange commands

Invocation: the full command line given in SKILL.md, then `<command> [options] --json`. JSON is also the default whenever stdout is not a terminal. Needs Node 22.13 or newer.

Options every list command takes: `--limit N|all` (default 20), `--fields a,b` to project columns, `--no-refresh` to read the cache as it is (an error when there is no cache). The output always carries `window`, `filtersApplied`, `evidence` and `truncated`, which says how many rows were cut.

Exit codes: 0 success, 1 a check failed, 2 usage or config error, 3 environment error (not a git repository, shallow clone without a stated window, Node too old). With `--json`, errors are JSON on stderr.

## brief PATH...

A compact briefing for the files about to be changed. One row per file, in path order.

| Field | Meaning |
|---|---|
| `path` | The file at the analysed commit. A path that was renamed away is followed to its current name, and `requested` keeps what was asked. |
| `exists` | The path is in the tree at the analysed commit. |
| `frequency`, `recentRevisions` | Logical changes in the analysis window, and in the recent window. |
| `lastChanged`, `ageDays` | Last revision, and days from it to the analysed commit. |
| `hotspotScore`, `recommendation` | The score `hotspots` gives the file, and `hotspot` when it is one. |
| `alongside` | Files that change with it, strongest confidence first: `confidence` (percent of changes to this file that also touched the partner), `reverseConfidence`, `degree`, `support`, `distance`. |
| `alongsideNotShown` | Partners that qualified but were cut by `--partners N` (default 5). |
| `note` | Why a row is empty: a new file or wrong path, no revisions in the window, or no partner reaching the minimums. |

A partner appears only when its support and degree reach `cochange.minSupport` and `cochange.minDegree`, and the partner still exists. `brief` is never stored as a report. It reads absolute paths inside the repository and strips `./`.

## hotspots [--by file|component]

Files (or components, which needs `components` in `code-health.json`) ranked by `score`: rank percentile of change frequency times rank percentile of complexity. Fields: `path`, `score`, `frequency`, `churn`, `complexity`, `ageDays`, `lastChanged`, `recommendation` (`hotspot` or null). The output names `complexitySource`: `indentation` (the proxy) or `complexity-report` (the complexity plugin's file report, used when it is current).

## age [--by file|component]

First-seen and last-changed over all usable history, oldest change first. Fields: `ageDays`, `firstSeen`, `lastChanged`, `revisions`, `recommendation` (`cold` when not changed within `cochange.staleMonths`).

## coupling [--file PATH] [--min-degree D] [--min-support S]

Pairs of files that changed in the same logical change. Fields: `path`, `with`, `degree`, `confidence` (path to with), `reverseConfidence`, `support`, `distance`, `findings` (`distant-coupling`, `asymmetric-coupling`), `dependent` (for an asymmetric pair, the file that depends on the other). With `--file`, the named file leads every row. The output states the eligible population, and a `note` when nothing reaches the thresholds. Lowering `--min-support` lists weaker pairs but never promotes them to findings.

Counts are over eligible logical changes: those at or below `cochange.maxChangesetSize` (default 30 files), after noise filtering. Bulk edits are left out of both sides of every ratio.

## clusters [--min-degree D] [--min-support S]

Connected components of the coupled-pair graph above the coupling minimums, ranked by score. Per row: `files`, `folders`, `size`, `spread` (mean pairwise tree distance), `meanDegree`, `findings` (`cluster` when the group spans three or more folders), and `magnets`: files in the group that change with many folders whose partners rarely change with each other (`change-magnet`).

## trend PATH [--samples N]

One file's indentation complexity, lines and bytes at up to N revisions (default 10, from 2 to 500) spread evenly over its history, the first and the last always included. `direction` is `worsening` or `improving` when complexity moved by at least 20 percent from the first sample to the last, `stable` otherwise, and `insufficient` with fewer than two samples. Samples are read from blobs, so no checkout is needed.

## spread [--since DATE] [--until DATE] [--bucket week|month]

Change-spread distribution per bucket, with an `overall` row. Dates are ISO 8601 (`2024-03-01`). `--since` is inclusive, `--until` exclusive, and a bare `--until` looks back the configured window from it. Per bucket: `logicalChanges`, `measured`, `singleFile`, `oversized`, `oversizedShare`, `excludedByTrailer`, `mean`, `median`, `p75`, `p90`, `max`. Changes carrying a `Code-Health:` trailer are left out and counted in `excludedByTrailer`.

## refresh

Updates the shared history cache and reports commits added. Analysis commands do this themselves.

## explain [rule]

Describes a recommendation rule: `hotspot`, `cold`, `distant-coupling`, `asymmetric-coupling`. `config explain` prints the effective config and where each value came from.

## Noise filters

Applied when the history is read, so config changes need no rebuild: the shared `exclude` globs, lockfiles, `.gitattributes` generated and vendored files, commits in `.git-blame-ignore-revs`, bot authors, pure renames, imported history, and commits beyond the shallow boundary. `filtersApplied.dropped` says how much each removed.

## Configuration

The `cochange` section of `code-health.json` at the repository root. Run `config explain` to see every value and its source.

| Setting | Default | Meaning |
|---|---|---|
| `windowMonths`, `recentMonths`, `staleMonths` | 12, 3, 12 | Analysis, recent and stale windows, back from the analysed commit's date. |
| `branch`, `firstParent` | `null`, `false` | The analysed ref, and whether to follow first parents only. |
| `maxChangesetSize` | 30 | Larger changes count for frequency but not for coupling or spread. |
| `minSupport`, `minDegree`, `minDistance` | 5, 30, 2 | Coupling minimums (degree in percent). |
| `hotspotPercentile` | 90 | A hotspot is in the top (100 minus this) percent. |
| `hook` | disabled | See [hook.md](hook.md). |
