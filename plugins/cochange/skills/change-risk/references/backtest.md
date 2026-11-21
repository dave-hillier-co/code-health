# The backtest

The factors come from research on change-level risk (Mockus and Weiss, Kamei et al., Bird et al., Rigby et al., Tornhill). Those studies report associations in the projects they examined. Whether the factors separate risky changes from safe ones in this repository is an empirical question, so `risk backtest` asks it of the repository's own history.

## What it does

It walks every merged change on the main line, oldest first. Each is measured, banded and placed **as of itself**: the hotspots, coupling and bands for a past change come from the history before it, never from today's figures, which would leak the outcome (a file that was fixed later is a hotspot now). Then it asks what became of each change.

A change counts as followed by trouble when it was reverted by a later change that names one of its commits, or a fix change touched its files within the follow-up window (default 30 days). Fixes are found by commit-message convention, so a repository without one gets reverts only, and the result says so. A change too recent for its window to have run is left out of every rate.

The file-level test over-counts in busy files, so each rate is shown beside the rate of the same files, not beside zero.

## What it leaves out

- **History layer only.** The structural factors would need a parse of every past change.
- **Placement without blame.** A blame at every past commit is not affordable, so past authors are placed by change familiarity and neighbourhood.
- Hotspots are ranked by change frequency alone, because complexity cannot be measured at every past commit. Pure moves are filtered from history, so `mixed-purpose` sees only moves that also edit the file.

## Reading the result

- `levels`: for routine, attention and elevated, the number of past changes, how many met trouble, the rate, and the rate of the same files.
- `factors`: the same for each factor's bands. This shows which heuristics carry signal in this repository and which carry none. A factor that does not separate can be switched off in `cochange.risk.disable`.
- `separation`: `separates` when the rate rises with the level among levels with enough changes, and beats the rate of the same files. `does-not-separate` when it does not. `insufficient` when too few changes met trouble or too few sit in a level to say.
- `completeness`: the share of `missing-co-change` findings whose named file was then edited soon after, which says whether the completeness signal finds real omissions.
- `elevatedShare`: the share of changes at `elevated`. If it is large, the level is inflating into noise.

## Before and after adoption

`risk backtest --adopted DATE` adds `adoption`: the share of merged changes followed by trouble in a window before the date against a window of the same length after it. The windows are equal so neither side has longer for a fix to arrive, and the after window stops where outcomes stop being known, a follow-up window before HEAD. `status` is `lower`, `higher` or `unchanged`, or `insufficient` when either side holds fewer than five changes. A lower rate after adoption is what the skill is for, but the comparison does not control for anything else that changed at the same time, so report it as an observation. An adoption run is printed and not stored.

## What follows from it

Run on a clean tree and without `--since`, the result is stored, and `risk` shows a level only when the stored result separates, stating the backtest beside it. If the levels do not separate, say so plainly and present the factors as observations. Do not offer a level the repository's own history does not support, and do not tune the settings until the backtest looks good: a threshold fitted to the answer is no longer evidence.
