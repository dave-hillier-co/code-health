# Measuring whether changes got cheaper

The analyser's gain says the tool moved code closer. It does not say anything got cheaper. `measure` does that: it records a baseline before the first tidy-up, then compares against it afterwards.

## Does distance cost anything here?

```
node ${CLAUDE_PLUGIN_ROOT}/dist/locality.mjs measure premise --json
```

Locality is worth the effort only where tasks that edit files further apart really cost more reads and tokens. `premise` tests that from existing history and session transcripts, so it can run before any move and before any baseline. `--since` and `--until` (days, `until` excluded) choose the window, which is the last `locality.windowMonths` back from HEAD otherwise.

Each task's distance is the change spread of the files it edited, and tasks editing a single file have none and are left out (`tasks.singleFile`). Each of `filesRead`, `reReads` and `tokens` is correlated with distance (Spearman), and the conclusion rests on the partial correlation that holds the number of files edited constant, because larger tasks both spread further and read more. `near` and `far` are the means either side of the median distance.

Read `verdict` with `tasks.measured`, `evidence` and `limits`:

- `supported` needs two figures that cost more when distant. `partly-supported` is one. Say how many tasks it rests on.
- `not-shown` is not evidence that distance is free: say the data shows no relationship.
- `not-measured` means distance (or cost) never varied across the tasks, for example when every task edited two files of one folder, so nothing could be tested. It is not a finding of no relationship. `tasks.singleFile` says how many one-file tasks were left out, since they have no distance.
- `insufficient-sample` means fewer tasks than `locality.measureMinSamples`: conclude nothing, and let locality's priority rest on the static signals.
- The result is an association over tasks nobody assigned to near or far files. It is not a measure of what a move would save. Only `measure compare` after a tidy-up shows that.

## Before the first move

```
node ${CLAUDE_PLUGIN_ROOT}/dist/locality.mjs measure baseline --json
```

Run it on the commit you are about to tidy, before any move. It writes `.code-health/local/locality.baseline.<name>.json` (`--name` picks the name, `default` otherwise). The file is outside the cache because it cannot be regenerated once the code has moved, so the command refuses to replace one unless you pass `--force`. Check `priorSuiteCommits`: above 0 means commits with a `Code-Health: locality` trailer already exist and the baseline was taken after the first tidy-up.

It records, over the twelve months (`locality.windowMonths`) back from HEAD's commit date:

- **Change spread**: the mean pairwise tree distance of the files of each logical change, each file at its path as of that change. The suite's own commits are left out.
- **Agent effort**: per task, from Claude Code session transcripts in `~/.claude/projects/` (`--projects-dir` names another), for this checkout and its worktrees: files read, folders visited, re-reads, edits and tokens. Only paths and counts are kept. Tasks with no edits are left out. Sessions in a transcript format the tool does not recognise are counted as `notMeasured`.
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
- Every difference carries `smallestSample`. Below `locality.measureMinSamples` the conclusion is `insufficient-sample`, and a difference within `locality.measureNoisePercent` of the starting figure is `no-change`.
- `claim` is all the data supports saying. `cheaper` needs effort to have fallen. `spread-without-effort` is unproven: say that spread fell and that no fall in effort has shown it mattered. `unproven` and `no-effect-shown` are not improvements.
- `structure` sets the leading indicator before and after. Read `structure.gaming` every time: `flagged` true means weighted import distance fell while the number of single-file folders or the maximum depth rose, so the distance was buried in nesting and not removed. Report that as gaming and do not count the gain; move the file back or flatten it. A `before` of null means the baseline predates these figures, so no check was possible.
- `spreadReproduced` false means history was rewritten since the baseline, so its spread no longer reproduces.

Moves that carried no `Code-Health:` trailer are not recognised as acted on. Spread from history alone cannot be the outcome for moves made from `analyse --source history`, because the target minimised the same distances. Agent effort is.
