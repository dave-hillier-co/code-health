# Measuring whether changes got cheaper

The analyser's gain says the tool moved code closer. It does not say anything got cheaper. `measure` does that: it records a baseline before the first tidy-up, then compares against it afterwards.

## Before the first move

```
node ${CLAUDE_PLUGIN_ROOT}/dist/locality.mjs measure baseline --json
```

Run it on the commit you are about to tidy, before any move. It writes `.code-health/local/locality.baseline.<name>.json` (`--name` picks the name, `default` otherwise). The file is outside the cache because it cannot be regenerated once the code has moved, so the command refuses to replace one unless you pass `--force`. Check `priorSuiteCommits`: above 0 means commits with a `Code-Health: locality` trailer already exist and the baseline was taken after the first tidy-up.

It records, over the twelve months (`locality.windowMonths`) back from HEAD's commit date:

- **Change spread**: the mean pairwise tree distance of the files of each logical change, each file at its path as of that change. The suite's own commits are left out.
- **Agent effort**: per task, from Claude Code session transcripts in `~/.claude/projects/` (`--projects-dir` names another), for this checkout and its worktrees: files read, folders visited, re-reads, edits and tokens. Only paths and counts are kept. Tasks with no edits are left out. Sessions in a transcript format the tool does not recognise are counted as `notMeasured`.
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
- `spreadReproduced` false means history was rewritten since the baseline, so its spread no longer reproduces.

Moves that carried no `Code-Health:` trailer are not recognised as acted on. Spread from history alone cannot be the outcome for moves made from `analyse --source history`, because the target minimised the same distances. Agent effort is.
