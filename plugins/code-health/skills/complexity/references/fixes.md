# Fixes: which functions the bug fixes changed

`fixes [paths...] [--max-commits N] [--evidence N]` reports, per function, how many fix changes (changes that landed on the main line) of the history window changed
it, in the manner of CodeScene's X-Ray. `analyse --with-fixes` adds the same figures as columns to the ranking. Both run one
computation.

## How a row is made

1. The window is `history.windowMonths` (default 12) back from HEAD, with the same noise filters as every history analysis:
   `exclude`, bot authors, and changes with more files than `history.maxChangesetSize`.
2. For each logical change that touched a source file, the lines it changed in the new revision are read with
   `git diff -U0` against the first parent. The new revision of each file is parsed through the shared parse cache, keyed by
   git blob, so a rerun parses nothing it has parsed before.
3. Each changed range is mapped onto the functions and methods that contain it. A function nested in another owns its own
   lines. A deletion counts for the function that holds the lines either side of it. A changed line outside every function
   counts against the file and is listed in `outsideUnits`, never against a function.
4. Each function is followed forward to the current revision with the matcher `check` uses: by identity first (a file renamed
   in git keeps its functions' identities), then by body similarity (`complexity.moveSimilarity`), so a function renamed
   inside its file keeps its history. `earlierIds` lists the earlier names. A function moved to a different file is not
   followed across files.
5. Fixes are counted per change that landed on the main line. A landed change is a commit on the first-parent line, or a
   merge commit with the commits that only its later parents reach, and it is a fix when its own text matches the shared
   definition (`history.fixPatterns`, `fixExcludePatterns`, `revertPatterns`, `fixMatchBody`): the message of a squash or
   direct commit, the pull request title of a merge. A revert is never a fix, and neither is a change whose text
   a fix pattern matched but an exclude pattern removed because it has a non-fix Conventional Commits type, or the fix was about typos, spelling, lint or formatting:
   it is counted in `fixesExcluded`. A fix made on a branch before it merged was caught in review, so it is not a regression:
   it is a fix during review (`reviewFixes`) and never a fix. A commit that created the file counts as one revision of each of its functions
   and never as a fix. A fix that created a function counts as one revision of it and never as a fix of it: a function is
   created by a commit when the revision before the commit has no function the matcher of step 4 pairs with it, so a function
   renamed by the fix is still fixed by it.

| Field | Meaning |
|---|---|
| `fixCommits` | Landed fix changes that changed a line of the function |
| `unitRevisions` | All landed changes that changed a line of the function, fixes included |
| `fixShare` | `fixCommits` over `unitRevisions`, 3 decimals |
| `cognitive` | The function's cognitive complexity now. Null for a deleted function |
| `labels` | `low evidence` when the function has fewer than `fixes.minRevisions` (3) revisions in the window |
| `reviewFixes` | Fix-like commits made on a branch before it merged that changed a line of the function. Caught in review, so not in `fixCommits` |
| `evidence` | The fix changes, newest first, up to `--evidence`: `sha`, `date`, `subject`, `pattern`, `matchedIn`. `evidenceOmitted` counts the rest |
| `reviewEvidence` | The fixes during review in the same fields, with `reviewEvidenceOmitted` |

Rows are the functions with at least one fix, sorted by `fixCommits`, then functions with enough revisions before `low evidence` ones, then `fixShare`. Functions deleted since are in
`deleted` (counted in `deleted.units`, listed up to `deleted.limit`, `deleted.omitted` more), because they cannot be acted on
but they show where fixes were needed. `summary` counts every function the window touched, so the rows are visibly a part.

## Read the header before the rows

- `fixConvention` says whether the landed titles use a recognisable fix form (Conventional Commits types, a leading Fix or
  Fixes, issue references), with `forms` counting each and `share` (fixes over landed changes) beside them as information.
  When `note` is not null, no form was seen, the counts are of the changes the patterns happened to match, and a function with no fix may simply have fixes
  nobody labelled. Say so when you report the rows. The default patterns match fix words at the start of the subject or
  after "to", and `bug`, `hotfix` and `defect` anywhere, so read the `evidence` subjects before quoting a count.
- `fixesExcluded` counts the changes a fix pattern matched and `history.fixExcludePatterns` removed (a non-fix Conventional Commits type, typos, spelling, lint, formatting), by the excluding pattern, with the first of them. If a real fix is in the list, the exclude
  pattern is too broad for this repository.
- `commits` says how many commits were analysed and how many were skipped, by cause: `maxCommits` (older commits beyond
  `--max-commits`, default `complexity.fixes.maxCommits`, null, which analyses the whole window; newest first), `oversized` (changes with more files than
  `history.maxChangesetSize`) and `noSourceFile` (touched no analysed source file). A skipped commit is in no row, so a
  count from a bounded run is a lower bound, and a table run prints a first notice saying how many commits the bound left out.
  `outsideUnits.fixCommits` counts each fix once; `outsideUnits.fixFileChanges` counts it once per file.
- `shallow` true means history before the clone's boundary is missing.
- `cache` says how many blobs were parsed in this run and how many came from the cache.

## Using it

A function with many fixes and a high `fixShare` is code that keeps being wrong: where complexity and fixes meet is where
simplification pays. A function above a complexity guideline with no fixes is a lower priority than a smaller one that is
fixed again and again. Run `explain` on the id of a row to see where its complexity comes from, then use the remedies
in [remedies.md](remedies.md). A high count is a place to look, not a defect: the extension point of a system changes and
is fixed often because it is used often.

## Stored result and the X-Ray report

A `fixes` run on a clean tree stores its result, and the default run is `complexity.fixes`, which the cochange hotspots report reads for its X-Ray of the top files (it lists only the functions that have a fix, so a function it does not list has none). A shallow clone stores nothing, because the same commit may have more history later. `--no-cache` computes the statistics again. `report xray FILE` computes the analysis and the statistics for one file itself and lists every function with its revisions and fixes.
