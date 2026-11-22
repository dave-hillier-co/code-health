---
name: abandonment
description: Estimates how much of the codebase's knowledge would be lost when people leave, where that risk sits in code that matters, and who should pick it up first. Use for questions about knowledge loss, bus or truck factor, "what happens if someone leaves", onboarding priorities, who should review or pair to spread knowledge, "who knows this code", and code nobody on the team wrote. It models random turnover and reports files and components with developers as counts. It is off until the repository opts in, and it declines to rank people, judge anyone's contribution or predict who will leave.
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cochange.mjs *)
---

# Abandonment risk

Code whose authors have all left is costlier to change. Their assumptions are gone, reviewers lack context, and nobody remembers why it is the way it is. Turnover is normal, so the question is not whether knowledge will be lost but how much, where, and with what tail risk. This skill measures that across many random scenarios instead of reporting one bus-factor number. The CLI computes the facts. You say what they mean and what to do.

The method is Rigby, Zhu, Donadelli and Mockus (ICSE 2016): a line is abandoned when its last author has left, a file when at least 90 percent of its lines are, and loss is simulated over many turnover scenarios. Definitions and guidelines: [references/method.md](references/method.md). Every command and field: [references/commands.md](references/commands.md).

## Rules about people

This is the most sensitive analysis in the suite. These rules are not optional.

- **It is off by default.** Every command refuses until `cochange.knowledge.enabled` is `true` in the repository's `code-health.json` (exit 2, `knowledge-disabled`). Do not switch it on yourself. Tell the user what the analysis does, that it reasons about people from git history only, and ask them to opt in. Only edit the config when they say yes.
- **No names by default.** Results are per file and per component, with developers as counts. Do not run `identities list` or any other command to find out who someone is, and do not guess from commit messages.
- **`successors --names` is the one command that shows identities**, and it shows only active developers, as recommended reviewers and pair partners. Run it only when the user wants to assign people to files at risk. It never lists the people who have left, and you must not work them out another way.
- **Do not rank people.** Decline to say who is most likely to leave, whose departure would hurt most, or who is "the risk". Decline to judge anyone's contribution or performance, and to speculate about individuals' plans. Say why: the model assumes departures are random and says nothing about any person, and a ranking of people reads as an evaluation of them. Offer what it can do: where knowledge concentrates, and who could pick it up.
- **No named scenarios.** There is no "what if Dana leaves" mode and you must not build one by overriding activity. `--mode k-leavers` samples uniformly and reports distributions only.
- **Overrides stay local.** If someone is on leave or has gone, `.code-health/local/knowledge-overrides.json` corrects who counts as active. It is ignored by git, and every abandonment command prints a warning on stderr if the file is tracked or not ignored. Never put identities in the committed config, in reports, issues or commit messages.
- The output of these commands is never stored as a report for other tools to read. Keep it that way: do not copy it into files in the repository.

## Workflow

All commands run as `node ${CLAUDE_PLUGIN_ROOT}/dist/cochange.mjs abandonment <subcommand> [options] --json`. Lists stop at 20 rows. Pass `--limit all` or `--top N` for more.

1. **Check enablement and freshness.** Run `abandonment current`. Exit 2 with `knowledge-disabled` means the repository has not opted in: stop and ask. The command refreshes the history and blame caches first. The first blame of a large repository is slow, and `-C` (following moved and copied lines, so a move does not reset authorship) is the slow part. `blame refresh` does it ahead of time and resumes if interrupted. `cochange.knowledge.copyDetection: false` turns `-C` off. If `blame.unknownFiles` is above zero, some files have no blame yet: their authorship is unknown, not zero, so say so.
2. **Check identities.** Run `identities check`. It reports counts and shares only. If `measurement.needsIdentityReview` is true, unmapped identities hold more than `cochange.identities.unmappedShareThreshold` percent of the lines: use the identities skill first, because one person under two emails looks like two half-time contributors and understates what their leaving costs. Report `measurement.headLines.mappedShare` beside the results. Do not repeat any names the check shows.
3. **Simulate.** Run `abandonment simulate`, which uses `rate` mode: each active developer leaves independently over the horizon (default one year) at the turnover rate observed in history. When `abandonment turnover` shows at least eight periods, also run `abandonment simulate --mode historical`, which samples the repository's own bad quarters and gives fatter tails. If the history is too short to estimate turnover, the command says so: ask the user for a rate (`cochange.knowledge.turnoverRate`) rather than inventing one.
4. **Say it in plain terms.** From `results.loss.files`: "In a typical year, expect to lose authorship of about M more files (`increment.expected`). In a bad year, one in twenty, around N more (`increment.atRisk[0].kar`). N files are already abandoned." Then the tail ratio (`kar` over `expected`): a high one means knowledge sits with few people, so a bad year is much worse than a typical one. Give the lines as well. Explain knowledge at risk (KaR) as the loss that is only exceeded in the worst 5 percent of years, and expected loss as the average year, because people confuse them. State the horizon, the turnover rate and where it came from (`selection.source`).
5. **Show the backtest.** Run `abandonment backtest`. Give its `precision` and `recall` with the simulation, so the user knows how well the model has predicted this repository's own past. Null means nothing was predicted or nothing was abandoned, which is not a score. If precision is low, say the ranking is a prompt to look, and that the files predicted were not the ones lost.
6. **Present the top files with their findings.** `results.files` is ranked by abandonment probability weighted by hotspot percentile, so code that keeps changing comes first. `--rank abandonment` gives the raw view, which puts old stable code first. Give each file's `findings` and the cheapest mitigation for it (below).
7. **Successors.** For files the user wants to act on, run `successors PATH...`. Without `--names` it gives ranks, scores and the coupling evidence. With the user's go-ahead, add `--names` to name the active developers who could review or pair. Propose assignments, never rankings of people.
8. **Connect to the rest of the suite and report the limits** (below).

## Findings and mitigations

| Finding | Meaning | Cheapest mitigation that works |
|---|---|---|
| `abandoned` | At least 90 percent of the lines held by people belong to people who have left | Adoption: assign the top successor to the next change. Prioritise it if it is also a hotspot. |
| `at-risk-hot` | Likely to be abandoned within the horizon, and it keeps changing | Knowledge transfer now: have successors review the next changes, pair on the next change to it, or hold a walkthrough. |
| `at-risk-cold` | Likely to be abandoned, and rarely changed | Lightweight capture: a short design note, or characterisation tests, written while someone who knows it is here. |
| `concentrated-component` | A component whose worst scenarios lose far more than a typical one | Rotate reviewers within the component so more people hold lines in it. |
| `no-successor` | No active developer has changed a file that changes with it | Escalate. Nobody is near this code, so adoption has no natural owner. |

Prefer reviews and pairing on changes that are happening anyway over meetings and documents. Nonobvious code and hard-to-describe code in an at-risk file strengthen the case for capturing knowledge before adoption: see [references/red-flags.md](references/red-flags.md).

## Interactions with the rest of the suite

- Simplifying an at-risk complex file (the complexity skill) reduces the knowledge needed to adopt it.
- Co-locating scattered code (the locality skill) reduces how much someone must know to change it safely.
- Hotspots and coupling come from the cochange skill. A file that is abandoned and a hotspot is where to start.

## Measuring whether it worked

Three commands give the instruments, all counts and no names:

- `cochange abandonment trend --points N` repeats the simulation at dates one period apart, each from the history and blame of the commit then, with one turnover rate and the same trials, seed, horizon and alphas at every point. Report the direction and the points together with the rate. A falling KaR after reviewers rotate, with no change in turnover rate, is the evidence that mitigation worked. If the points were taken with different settings they are not comparable, so say so rather than compare them.
- `cochange abandonment redundancy` gives the share of hotspot files with at least two active authors each holding at least 10 percent of the lines (`--min-authors`, `--min-share`): redundancy in important code. Run it before and after the mitigation and report the counts behind the share.
- `cochange abandonment adoption --at DATE` takes the files abandoned at a past date and reports how many were picked up by an active developer within the horizon, and how many by one of the top recommended successors, using only the history before that date. A hit rate below the paper's 34 to 48 percent is a reason to trust `successors` less here, not to drop it.

The backtest tells you whether the model is calibrated for this repository at all.

## Limits to report

- Inactivity is a proxy. Someone on leave or moved to another repository looks inactive until an override says otherwise.
- Blame measures authorship, not understanding. A line's last author may not know why it is there, and a reviewer may know a file well without a line in it.
- The 90 percent abandonment share is the paper's convention, and the at-risk probability and tail ratio are guidelines that order and label files. Each is configurable, and none hides a file.
- Turnover is assumed random. Occasional contributors leave at a higher rate than established ones, so one pooled rate can overstate the loss of core authors.
- Agent-authored lines have no knowledge to lose. How to attribute them is an open policy question, not something to decide silently.
- Renamed files are followed by blame, but a backtest compares files by path, so heavy renaming lowers its scores.
