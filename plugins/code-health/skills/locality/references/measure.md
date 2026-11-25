# Measuring whether changes got cheaper

The analyser's gain says the tool moved code closer. It does not say anything got cheaper. `measure` does that: it records a baseline before the first tidy-up, then compares against it afterwards.

## Before the first move

```
node ${CLAUDE_PLUGIN_ROOT}/dist/locality.mjs measure baseline --json
```

Run it on the commit you are about to tidy, before any move. It writes `.code-health/local/locality.baseline.<name>.json` (`--name` picks the name, `default` otherwise). The file is outside the cache because it cannot be regenerated once the code has moved, so the command refuses to replace one unless you pass `--force`. Check `priorSuiteCommits`: above 0 means commits with a `Code-Health: locality` trailer already exist and the baseline was taken after the first tidy-up.

It records, over the twelve months (`history.windowMonths`, or `locality.windowMonths`) back from HEAD's commit date:

- **Change spread**: the mean pairwise tree distance of the files of each logical change, each file at its path as of that change. The suite's own commits are left out.
- **Agent effort**: per task, from Claude Code session transcripts in `~/.claude/projects/` (`--projects-dir` names another), for this checkout and its worktrees, main sessions and subagent transcripts alike (`--source` limits it, `--effort tools|all` chooses whether the files named in Bash commands count, and `measure compare` reads what the baseline did): files read, folders visited, re-reads, edits and tokens, with `shell` giving the Bash calls and the share parsed. Only paths and counts are kept. Tasks with no edits are left out. Sessions in a transcript format the tool does not recognise are counted as `notMeasured`.
- **Structure**: total weighted import distance (the leading indicator), the number of folders holding a single production file, and the maximum folder depth (the gaming check), as `structure`.
- **The ranked candidates** of `analyse`, each with its files and its consumers, so the comparison group can be drawn later (`--candidates` limits how many are kept, 200 by default).
- **Read heat**: the files most tasks read, for deciding where to start.

If `evidence.grade` is `weak`, or there are few tasks, say so now: the comparison will not be able to conclude anything.

## After the tidy-up

```
node ${CLAUDE_PLUGIN_ROOT}/dist/locality.mjs measure compare --json
```

Commits with a `Code-Health: locality <rule>` trailer since the baseline say what was acted on: the baseline's candidates whose files were renamed or removed. For each, the candidate of nearest baseline rank that was left alone joins the comparison group, so a result is the difference between two groups, not a raw before and after. Extreme values drift back towards the average when left alone, and the comparison group shows how much of the change is that. A left-alone candidate that shares a file with something acted on is passed over (`suite.overlapping`).

The windows match: the after window has as many days as the baseline's, starts the day after the suite's last commit (`--since` overrides it), and is cut short where HEAD ends it (`after.complete` is false). Both are cut at the same days for history and transcripts, with the same filters.

Reading the result:

- `effort.conclusion` is the primary outcome. `lower` means at least two of files read, folders visited, re-reads and tokens fell more than for the comparison group and none rose.
- `spread.conclusion` is an outcome by construction, since the target minimises the distances spread measures. It shows that changes now land closer together.
- Every difference carries `smallestSample`. Below `locality.measureMinSamples` (a floor) the conclusion is `insufficient-sample`, `lowConfidence` is true, and `observed` still shows the direction the figures give: report it as low confidence, not as a result. A difference within `locality.measureNoisePercent` (a guideline) of the starting figure is `no-change`. `percentOfStart` and `ratioToNoiseGuideline` say how far inside or past the guideline it sits, so a ratio just under 1 is a near miss and not a flat zero.
- `suite.untrailered` counts baseline candidates whose files were renamed or removed by a commit without the `Code-Health: locality` trailer. They are in neither group. If it is not zero, say that some moves were not attributed to the tool.
- `claim` is all the data supports saying. `cheaper` needs effort to have fallen. `spread-without-effort` is unproven: say that spread fell and that no fall in effort has shown it mattered. `unproven` and `no-effect-shown` are not improvements.
- `structure` sets the leading indicator before and after. Read `structure.gaming` every time: `flagged` true means weighted import distance fell while the number of single-file folders or the maximum depth rose, so the distance was buried in nesting and not removed. Report that as gaming and do not count the gain; move the file back or flatten it. A `before` of null means the baseline predates these figures, so no check was possible.
- `spreadReproduced` false means history was rewritten since the baseline, so its spread no longer reproduces.

## What one change does to import distance

```
node ${CLAUDE_PLUGIN_ROOT}/dist/locality.mjs measure change --json
```

It needs no baseline. It reads two revisions and prints how the total import distance differs between them. With no argument it measures the current branch against its merge base with the main branch, and on the main branch it measures the last commit against its first parent. `measure change BASE` and `measure change BASE..HEAD` name the range, as `cochange risk` reads one. Both revisions are read with the config of the checkout.

The total (`totalUseDistance`) is the sum, over import edges from files reachable from an entry point, of use count times tree distance. It leaves out the co-change weighting that `analyse` adds to `metrics.totalWeightedDistance`, because that depends on the history window and not on the revision, so the two totals are equal only with `locality.useHistory` off.

Reading the result:

- `delta` is `after.totalUseDistance` minus `before.totalUseDistance`. A change that adds code adds edges, so `delta` is above zero for most changes and mostly follows how much was added. Do not report a positive `delta` alone as a problem.
- `parts.added.meanDistancePerUse` is the figure for where the new code was placed, and `parts.added.ratioToCodebaseMean` sets it against `before.meanDistancePerUse`. Above 1, the uses this change added are further apart than the codebase's uses were. It is a ratio to read, not a pass or fail.
- `parts` splits `delta` exactly: `added.distance` minus `removed.distance`, plus `moved.distance` (a file at one end was renamed), `reweighted.distance` (the use count of an existing import changed) and `reachability.distance` (the importing file became reachable from an entry point, or stopped being reachable; the files are in `reachability.gained` and `reachability.lost`).
- `edges` lists the changed edges, largest absolute `change` first, each with its use count and distance before and after. `--edges <n|all>` sets how many (20 by default) and `edgesOmitted` counts the rest. Name the first few added edges with a high distance when asked what in the change is distant.
- A renamed file keeps its edges when git detects the rename (`renamedFiles`). A file moved and rewritten in one change is read as edges removed and added: `delta` is the same and the split is not.
- `structure.gaming` is the same check as in `measure compare`: `flagged` true means the distance fell while single-file folders or the maximum depth rose.

This is a leading indicator of one change. It says what the change did to the import graph, and nothing about whether later changes cost less.

## Limits

Moves that carried no `Code-Health:` trailer are not recognised as acted on. Spread from history alone cannot be the outcome for moves made from `analyse --source history`, because the target minimised the same distances. Agent effort is.
