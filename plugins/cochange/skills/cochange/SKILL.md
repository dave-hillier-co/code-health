---
name: cochange
description: Use before changing a file ("what usually changes with this file?", "what else will I have to touch?", "is this a risky file to edit?"), when asked where change effort concentrates ("which code is hardest to change?", "where should we refactor first?", "hotspots", "churn", "code that changes every week"), when asked which files change together or why a change touches so many places ("hidden dependencies", "temporal coupling", "files in different folders that always change together"), and when asked whether a refactoring made later changes cheaper ("did moving these files help?", "change spread before and after"). Mines git history. Not for reviewing a branch's risk, who knows the code, or merging author identities, and it never edits code.
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cochange.mjs *)
---

# Co-change

History shows how code is actually changed. A complex file nobody touches costs nothing. A complex file changed every week is where effort goes. Two files that always change together, in different folders, are a dependency the imports may not show. This skill reads git history through a CLI and decides what the numbers mean. The CLI computes facts. You supply judgement.

It ranks where to look and never edits code. Refactoring itself is for the skills that edit.

## Running the CLI

Every command is:

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cochange.mjs <command> [options] --json
```

`${CLAUDE_PLUGIN_ROOT}` is replaced in this text before you see it. Use the full path as written, since the variable is not set in the shell. Commands refresh the history cache first (cheap when nothing is new). Lists default to 20 rows. Pass `--limit N`, `--limit all` or `--fields a,b` when you need other. Details of every command and field are in [references/commands.md](references/commands.md).

If a command reports a shallow clone, tell the user history is truncated. Do not work around it unless the repository's `code-health.json` states a window (`history.windowMonths`, or `cochange.windowMonths`) or they ask for one.

## Read the evidence first

Every result has an `evidence` block with a grade: `strong`, `moderate` or `weak`. Check it before you say anything history-based.

- `strong`: co-change is the best evidence you have. Where it disagrees with what the imports suggest, trust the history.
- `moderate`: report findings, and say how many changes sit behind each.
- `weak` (young repository, few contributors, few changes): present every finding as tentative, lean on static signals, and never let co-change overturn them. Say plainly when `coupling` returns nothing: the guidelines were not lowered, and a sparse history has little to show.

Always give the support behind a coupling claim ("5 shared changes out of 27"), not just a percentage. Two shared commits out of three is too little evidence to separate coupling from chance. Details and guidelines: [references/reading-results.md](references/reading-results.md).

These are prompts for investigation, not verdicts. The tool measures code, not people. If asked to judge or rank individuals from this data, decline and say why.

## Choose the playbook

| The user asks | Playbook |
|---|---|
| About to change or review specific files | Before a change |
| Where effort goes, what to refactor first | Hotspot review |
| What changes together, hidden dependencies | Coupling review |
| Did a change make things cheaper | Measuring an outcome |

## Before a change

Run this before a non-trivial task, on the files you expect to edit. Skip it for a typo or a one-line fix.

1. `brief PATH...` with every file you plan to change.
2. For each file, read `fixes` and `fixShare` (how many of its changes were repairs) and `alongside`. Each entry names a file that changed in the same logical change `confidence` percent of the time (`reverseConfidence` is the other direction), with its `support` and tree `distance`.
3. Open the strongest partners deliberately, before editing, and decide whether this change needs them. A sibling test is expected. A distant partner is the interesting one.
4. If `recommendation` is `hotspot`, say so: the file is complex and changes often, so keep the change small and check its tests first.
5. If `note` is set, the file has no evidence (new file, a file with no revisions in the window, wrong path). Say that and go on.

Partners are evidence of what usually changed, not a requirement. A partner you leave alone should be a decision you can state.

When the repository enables the completeness hook, a one-sentence note may appear after an edit naming a usual partner you have not touched. Treat it as the same kind of prompt. How the hook works and how to enable it: [references/hook.md](references/hook.md).

## Hotspot review

1. `hotspots --limit 20`. Note `complexitySource` (`indentation` is a proxy, `complexity-report` is more precise) and the evidence grade.
2. Take the rows with `recommendation: "hotspot"`. Ignore the rest unless asked.
3. `age` shows which of them are `cold` (not changed within the stale window). Cold code is the cheapest to leave alone, so it is the lowest priority.
4. For each hotspot, read the file's worst functions. Then name the red flag you judge present, or say none applies. The vocabulary is in [references/red-flags.md](references/red-flags.md). Nonobvious code, shallow modules and special-general mixtures are the common ones in a hotspot.
5. `trend PATH` shows whether a hotspot's complexity is worsening, improving or stable over its history. A file whose complexity is improving needs less urgent attention than one that is worsening.
6. `fixes --limit 20` shows where changes were repairs. Read its `fixConvention` first, and read the `evidence` commits of the top rows before relying on a count: the patterns match words, not defects. Read a hotspot with a high `fixShare` as complex code that is being repaired. How to read it: [references/reading-results.md](references/reading-results.md#fix-counts).
7. `test-drift` on a row means a frequently changed source file whose sibling test never changes with it: check whether behaviour is changing without tests.
8. Report a short ranked list: file, why it is a hotspot (frequency, complexity, recency, fix share), the red flag, and the suggested handoff, which is a complexity review of its worst functions.

A hotspot with no red flag and no outcome evidence is a candidate for dismissal. Say so and record why.

## Coupling review

1. `coupling` for the repository, or `coupling --file PATH` for one file.
2. Look at `findings` on each row:
   - `distant-coupling`: strong coupling across far-apart folders. Ask whether the files belong together. If they should stay apart, look for one design decision encoded in both files. That is the **information leakage** red flag.
   - `asymmetric-coupling`: one file nearly always drags the other, not the reverse. The dependent file relies on the other implicitly. Look for **information leakage** or **temporal decomposition**.
3. A pair that also references each other in both directions in code is **conjoined methods**. This plugin has no parser, so you check that by reading the code.
4. Before you recommend anything, open both files and confirm the coupling is real: shared constants, a registry or list that must be kept in step, a format written in one and read in another. A coupling you cannot explain after reading the code is a finding to report as unexplained, not one to act on.
5. Report each pair with support, both confidences, distance, the red flag or "none applies", and the handoff: a locality review for co-location, or a design change that removes the shared decision.

Coupling between a file and its sibling test has distance 0 and is expected. Do not report it as a problem.

`clusters` lists groups of mutually coupled files with their spread, and flags the change magnets: files that change with many folders whose partners rarely change with each other. A `change-magnet` is probably a registration hub. Say so and ask before proposing a change. A `cluster` spanning three or more folders may be one unit spread across the tree: hand it to a locality review.

## Measuring an outcome

Use this when someone acted on findings and asks whether it helped. Change spread is the measure: the mean pairwise tree distance between the files of one logical change. Falling spread means changes became more local.

1. Take a baseline before the work: `spread --until DATE --bucket month`, with the same filters you will use afterwards. A baseline cannot be taken after the fact once history has moved on, so offer to take one at the start of any refactoring effort.
2. After the work, run `spread --since DATE` over a window of matching length.
3. Report sample sizes (`measured` per bucket) next to every figure, and the `oversizedShare`, since the widest changes are left out of the distribution and a shift in that share is part of the result.
4. Do not compare raw before and after for the files you acted on. They were chosen because they were extreme, and extreme values drift back toward average when left alone. `outcome spread --at DATE PATH...` does the comparison: it sets each acted-on file beside the untouched file of nearest rank (by revisions in the before window, skipping files that changed together with an acted-on one), over matching windows either side of the date, and reports the difference between the two groups' changes in spread (primary) and revisions per file (secondary). Read its `conclusion`, `smallestSample` and `windows.after.complete`, and name the sample sizes.
5. Spread falls by construction when files that change together are moved together. Say so, and treat it as a leading indicator, not proof that work got cheaper.
6. If the data cannot show an effect, say that. Do not claim one.

To ask whether the completeness hook helped agents, run `outcome completeness --since DATE --until DATE`. It reads the session transcripts on this machine (paths and counts only) and reports, with and without the hook, how often an edit to a file with unedited coupled partners was followed by an edit to one of them later in the same session. Sessions were not assigned to the hook at random, so report the difference as an association, with its sample sizes, and say when `conclusion` is `insufficient-sample`.

Commits made through the suite's skills carry a `Code-Health:` trailer. `spread` leaves those out and reports how many in `excludedByTrailer`.

## Recording decisions

Report what you acted on and what you dismissed, each with the reason. When a finding is dismissed because a red flag does not apply, or a signal looks like a false positive, say which. If work follows from a finding, its commit message records the rule that fired and the support behind it, and ends with a `Code-Health: cochange <rule>` trailer so the commit stays out of outcome windows.

## What not to do

- Do not run `refresh` on its own. Analysis commands refresh when they need to.
- Do not edit `code-health.json` to make a finding appear or vanish. To tune guidelines, show the user the setting and let them decide.
- Do not quote author names or emails from history. Default outputs carry none, and a request to evaluate individuals is out of scope.
- Do not read a hotspot as a verdict, or a coupling as a defect.
