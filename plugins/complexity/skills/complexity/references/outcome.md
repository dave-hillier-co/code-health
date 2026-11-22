# Outcome: did the simplification make the code cheaper to change

`outcome <rev> [--from <rev>] [--projects-dir <dir>]` measures a simplification after the fact. `<rev>` is the last commit
of the simplification and `--from` the first (default: the same commit). The files it changed that exist before and after
and have functions are the acted-on files. The baseline is the commit before the first one.

Each figure is given before and after, for the acted-on files and for a comparison group. The comparison group is the same
number of unchanged files with functions, matched one to one by the highest metric percentile of their functions before the
change. Findings are acted on because they are extreme, and extreme values drift back towards the average when left alone,
so the `difference` block subtracts the comparison group's movement from the acted-on files'.

The windows are `history.windowMonths` long (default 12, `complexity.windowMonths` overrides it) before and after the last commit. The after window stops at HEAD's date when that comes first,
and `windows.after.complete` says whether it ran its full length; an incomplete window is shorter than the before window, so
read counts with that in mind. The simplification's own commits and every commit with a `Code-Health:` trailer are left out of
both, and so are the agent sessions that made the simplification.

| Block | Measures | Role |
|---|---|---|
| `changeCost` | `changes` (logical changes touching the files, the sample size), `linesChurnedPerChange` (lines added plus deleted in the files) | Primary outcome |
| `changeCost.*.fixCommitRate` | Share of those changes with a commit that matches `history.fixPatterns` (fix words at the start of the subject or after "to", bug, hotfix and defect anywhere, or a `fix:` prefix; a revert is not a fix, and neither is a fix of typos, lint, docs or tests, which `history.fixExcludePatterns` removes). `changeCost.*.fixCommits` lists the matching commits with the pattern that matched, because some matches are not defects. Read it before quoting the rate | Secondary outcome, only meaningful where `fixConvention.note` is null |
| `rank` | Mean rank score of the acted-on functions: highest metric percentile times the change weight at that date | Leading indicator only, because the tool moves it by construction |
| `gamingCheck` | Function count and mean interface depth of the acted-on files; `suspected` when the count rose while the depth fell | Gaming check |
| `agentEffort` | Files read, re-read, folders visited, edits and tokens per task that edited the files, from Claude Code transcripts under `--projects-dir` | Primary outcome where transcripts exist; `not-measured` with a reason otherwise |

Only paths and counts are read from transcripts. Without enough changes in a window a figure is `null`: say the data cannot
show an effect, never read a null as zero.
