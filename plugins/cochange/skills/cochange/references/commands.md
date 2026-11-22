# cochange commands

Invocation: the full command line given in SKILL.md, then `<command> [options] --json`. JSON is also the default whenever stdout is not a terminal. Needs Node 22.13 or newer.

Options every list command takes: `--limit N|all` (default 20), `--fields a,b` to project columns, `--no-refresh` to read the cache as it is (an error when there is no cache). `hotspots`, `coupling` and `brief` print a result stored for the same commit, config and options without reading history, and say so in `inputs.resultsCache`; `--no-cache` computes the result again. The output always carries `window`, `filtersApplied`, `evidence` and `truncated`, which says how many rows were cut.

Exit codes: 0 success, 1 a check failed, 2 usage or config error, 3 environment error (not a git repository, shallow clone without a stated window, Node too old). With `--json`, errors are JSON on stderr.

## brief PATH...

A compact briefing for the files about to be changed. One row per file, in path order.

| Field | Meaning |
|---|---|
| `path` | The file at the analysed commit. A path that was renamed away is followed to its current name, and `requested` keeps what was asked. |
| `exists` | The path is in the tree at the analysed commit. |
| `frequency`, `recentRevisions` | Logical changes in the analysis window, and in the recent window. |
| `fixes`, `fixShare` | Changes that landed on the main line in the window whose own title or message is a fix (a merge by its pull request title), and their share of the landed changes that touched the file, as `fixes` counts them. A count of messages, not of defects. |
| `lastChanged`, `ageDays` | Last revision, and days from it to the analysed commit. |
| `hotspotScore`, `recommendation` | The score `hotspots` gives the file, and `hotspot` when it is one. |
| `alongside` | Files that change with it: `confidence` (percent of changes to this file that also touched the partner), `reverseConfidence`, `degree`, `support`, `distance`, and `aboveGuideline` (degree at or above `cochange.minDegree`). Partners at or above the guideline come first, then the rest, each strongest confidence first. |
| `alongsideNotShown` | Partners with enough support that were cut by `--partners N` (default 5). |
| `note` | Why a row is empty: a new file or wrong path, no revisions in the window, or no partner with enough shared changes, or none at the degree guideline. |

A partner is listed when its support reaches `cochange.minSupport` (below that the shared changes are too few to mean anything) and the partner still exists. `cochange.minDegree` is a guideline: partners under it are listed after the others and marked. `brief` is computed from the stored hotspot ranking, coupling pairs and per-file activity (the first briefing for a commit stores all three), so a briefing after it is quick; `--no-cache` computes all three again. A briefing is never stored itself. It reads absolute paths inside the repository and strips `./`.

## hotspots [--by file|component] [--all-files]

Files (or components, which needs `components` in `code-health.json`) ranked by `score`. Only code is ranked, the files a language adapter or lexical profile claims; `--all-files` ranks lockfiles, documents, data and the like as well, and `dropped.nonCode` counts the files left out. Ranked by `score`: rank percentile of change frequency times rank percentile of complexity. Fields: `path`, `score`, `frequency`, `churn`, `complexity`, `ageDays`, `lastChanged`, `fixes`, `fixShare`, `recommendation` (`hotspot` or null). The output names `complexitySource`: `indentation` (the proxy) or `complexity-report` (the complexity plugin's file report, used when it is current), and carries `fixConvention`. `fixes` and `fixShare` do not change the score.

## fixes [--by file|component] [--all-files] [--evidence N]

Files (or components) sorted by fix count, then path. Code only, unless `--all-files`; `dropped.nonCode` counts what was left out. Fields: `fixes` (changes that landed on the main line and are fixes by their own title or message, a merge by its pull request title), `revisions` (every commit that touched the file), `landedChanges`, `fixShare` (`fixes` over `landedChanges`), `recentFixes` (inside `cochange.recentMonths`), `lastFix`, `reverts`, and `evidence`: the matching changes newest first (`sha`, `date`, `subject`, `pattern`, `matchedIn`), at most `--evidence N` (default 5), with `omitted` counting the rest. `reviewFixes` and `reviewEvidence` list the fix-like commits made on a branch before it merged: caught in review, so they are never in `fixes`. A revert is its own column and is not a fix. A fix is defined once for the suite by `history.fixPatterns`, `history.revertPatterns` and `history.fixMatchBody` (or `cochange.` overrides). The output carries `fixConvention`: `followsConvention` (whether the landed titles use a recognisable fix form), `forms` (how many titles use Conventional Commits types, a leading Fix or Fixes, or an issue reference), the `share` of landed changes that are fixes as information beside them, and a `note` when no form is seen. The table prints the note as a `Notice`. Every file is listed whatever its count, and `--limit` reports how many rows it cut. A run with `--by component` or `--evidence` is not stored as a report.

## age [--by file|component] [--all-files]

First-seen and last-changed over all usable history, oldest change first. Fields: `ageDays`, `firstSeen`, `lastChanged`, `revisions`, `recommendation` (`cold` when not changed within `cochange.staleMonths`).

## coupling [--file PATH] [--min-degree D] [--min-support S]

Pairs of files that changed in the same logical change. Fields: `path`, `pathKind`, `with`, `withKind` (`code` or `non-code`: a lockfile changing with its manifest is listed and labelled), `degree`, `aboveGuideline` (degree at or above `cochange.minDegree`; pairs under it come after the others), `confidence` (path to with), `reverseConfidence`, `support`, `distance`, `findings` (`distant-coupling`, `asymmetric-coupling`), `dependent` (for an asymmetric pair, the file that depends on the other). With `--file`, the named file leads every row. The output states the eligible population, and a `note` when no pair reaches the support floor. Lowering `--min-support` lists weaker pairs, marks them low confidence (`evidence.clearsMinimum` false) and never promotes them to findings.

Counts are over eligible logical changes: those at or below `history.maxChangesetSize` (default 30 files, overridable as `cochange.maxChangesetSize`), after noise filtering. Bulk edits are left out of both sides of every ratio.

## clusters [--min-degree D] [--min-support S]

Connected components of the coupled-pair graph, ranked by score. A pair is a link when it reaches both `--min-support` and `--min-degree`: here the degree is a cut, because a group is defined by its links. Per row: `files`, `folders`, `size`, `spread` (mean pairwise tree distance), `meanDegree`, `findings` (`cluster` when the group spans three or more folders), and `magnets`: files in the group that change with many folders whose partners rarely change with each other (`change-magnet`).

## trend PATH [--samples N]

One file's indentation complexity, lines and bytes at up to N revisions (default 10, from 2 to 500) spread evenly over its history, the first and the last always included. The summary prints `changeRatio` (last against first), the `guideline` of 0.2, and the `peak` sample. `direction` is `worsening` or `improving` when the ratio is at or beyond the guideline in that direction, `stable` otherwise, and `insufficient` with fewer than two samples. Read the ratio and the peak, not only the label. Samples are read from blobs, so no checkout is needed.

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

The history settings are shared. Set them once in the top-level `history` section, and set one under the same name in `cochange` only when cochange needs a different value. `config explain` shows which of the two a value came from.

| Shared setting (`history.<name>`, `cochange.<name>` overrides) | Default | Meaning |
|---|---|---|
| `windowMonths` | 12 | Analysis window, back from the analysed commit's date. |
| `branch`, `firstParent` | `null`, `false` | The analysed ref, and whether to follow first parents only. |
| `maxChangesetSize` | 30 | Larger changes count for frequency but not for coupling or spread. |
| `botPatterns` | `[]` | Regular expressions matched against `Name <email>`. Commits by matching authors are left out. |
| `fixPatterns`, `fixExcludePatterns`, `revertPatterns`, `fixMatchBody` | see the schema, `false` | What counts as a fix, per landed change (fix words at the start of the subject or after "to", the whole words bug, hotfix and defect, a `fix:` prefix, a merge of a fix branch), what removes one (a change with a non-fix Conventional Commits type, or a fix of typos, spelling, lint or formatting, counted as `fixesExcluded` with the excluding pattern) and what is a revert. Commit bodies are matched only with `fixMatchBody`. Counts list the matching commits. |
| `renameSimilarity`, `renameLimit` | 50, 1000 | Rename detection for git's `-M`. |
| `evidence` | see the schema | Guidelines that grade the evidence of a history. |

The settings of the section itself:

| Setting | Default | Meaning |
|---|---|---|
| `recentMonths`, `staleMonths` | 3, 12 | Recent and stale windows, back from the analysed commit's date. |
| `minSupport`, `minDegree`, `minDistance` | 5, 30, 2 | Support is an evidence floor, degree and distance are guidelines (degree in percent). |
| `hotspotPercentile` | 90 | A hotspot is in the top (100 minus this) percent. |
