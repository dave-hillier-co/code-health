# Outcome: did the simplification make the code cheaper to change

`outcome <rev> [--from <rev>] [--projects-dir <dir>]` measures a simplification after the fact. `<rev>` is the last commit
of the simplification and `--from` the first (default: the same commit). The files it changed that exist before and after
and have functions are the acted-on files. The baseline is the commit before the first one.

Each figure is given before and after, for the acted-on files and for a comparison group. The comparison group is the same
number of unchanged files with functions, matched one to one by the highest metric percentile of their functions before the
change. Findings are acted on because they are extreme, and extreme values drift back towards the average when left alone,
so the `difference` block subtracts the comparison group's movement from the acted-on files'.

The windows are `windowMonths` long (default 12) before and after the last commit, up to HEAD's date. The simplification's own
commits and every commit with a `Code-Health:` trailer are left out of both.

| Block | Measures | Role |
|---|---|---|
| `changeCost` | `changes` (logical changes touching the files, the sample size), `linesChurnedPerChange` (lines added plus deleted in the files) | Primary outcome |
| `changeCost.*.fixCommitRate` | Share of those changes with a commit whose subject starts with `fix`, `bugfix` or `hotfix` | Secondary outcome, only meaningful where the repository follows that convention |
| `rank` | Mean rank score of the acted-on functions: highest metric percentile times the change weight at that date | Leading indicator only, because the tool moves it by construction |
| `gamingCheck` | Function count and mean interface depth of the acted-on files; `suspected` when the count rose while the depth fell | Gaming check |
| `agentEffort` | Files read, re-read, folders visited, edits and tokens per task that edited the files, from Claude Code transcripts under `--projects-dir` | Primary outcome where transcripts exist; `not-measured` with a reason otherwise |

Only paths and counts are read from transcripts. Without enough changes in a window a figure is `null`: say the data cannot
show an effect, never read a null as zero.
