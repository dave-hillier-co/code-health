# Measuring a repackaging

A repackaging succeeded only if change got cheaper, not because the package count fell.

| Measure | What it shows | Role |
|---|---|---|
| Agent effort on tasks touching the reshaped packages | Navigation and build context got cheaper | Primary outcome |
| Packages touched per logical change, against comparable packages left alone | Changes land in fewer packages | Outcome. By construction for a merge |
| Closure of the reshaped packages | Changes stay inside the new boundaries | Outcome. By construction for a merge |
| Reuse profile and export components of the result | Merging did not create a dumping ground | Gaming check |
| Package count, median distance `D` | Structure moved in the expected direction | Leading indicator only |

## Before

Before the first step, run `packages list --json` and keep it with the commit it was made at. It records closure, consumers, `A`, `I` and `D` for every package. Note who will do the tasks that touch the packages, because agent effort comes from their session transcripts.

## After

Wait for enough changes. Then run, with the last commit of the repackaging:

```
node ${CLAUDE_PLUGIN_ROOT}/dist/structure.mjs packages outcome <last-commit> --from <first-commit> --json
node ${CLAUDE_PLUGIN_ROOT}/dist/structure.mjs packages outcome <last-commit> --from <first-commit> --projects-dir ~/.claude/projects --json
```

A merge is two commits: `--from` the first (which moves the files), the revision the second (which removes the manifest). A split or a move is one commit and needs no `--from`. The commits of the repackaging itself are left out of both windows.

How to read the result:

- **`reshaped`** names what was replaced and created. A package that kept its name and took in another's files is part of the unit on both sides.
- **`before` and `after`** are the figures for the unit: `changes`, `packagesPerChange` and `closure`. In the earlier window the packages that were replaced count as one unit, so before and after compare like with like. `comparable` gives the same figures for packages left alone with a comparable share of changes, as the control: if they moved the same way, the reshaping is not what changed.
- **`byConstruction: true`** means a merge. Merging lowers packages per change and raises closure whatever else happens, so those two show only that the merge took place. Do not report them as success. Agent effort is the independent test.
- **`reuse.tradedOneCostForAnother`** is the gaming check. Closure can be gamed by merging everything into one package, which has perfect closure. If closure rose while the result's consumers use a falling share of it, say that the merge traded one cost for another, and that the result may be a dumping ground.
- **`leading`** is package count and median distance. It moved or it did not. It is not the outcome.
- **`agentEffort`** compares tasks (one user prompt and the agent turns after it) that edited the reshaped packages, before and after, with tasks that edited other packages as a control: files read, folders visited, re-reads, edits and tokens. `not-measured` says why. The transcript format is internal to Claude Code and can change, so a version it does not recognise is reported and not guessed.

## Report with its limits

State the sample sizes (`changes`, `tasks`) and say what the evidence does not show. A small after-window shows nothing yet. History cannot say whether the agents did different work. Never report a leading indicator as the result.
