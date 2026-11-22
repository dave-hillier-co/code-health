---
name: change-risk
description: Assesses a branch, merge request or pull request before it is reviewed or merged, and says how it should be reviewed. Use when someone asks "how risky is this change", "what should the reviewer look at", "who should review this", "is this ready for review", or wants a pre-flight check of their own branch before asking for review. It shows how much of the codebase the change puts at risk, files that usually change with the touched files and are missing, and how well placed the author is in that code, then recommends completing, splitting, testing or routing review. History only. It never gates a merge, ranks authors or judges a person.
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cochange.mjs *)
---

# Change risk

Review effort is usually spread evenly, or by size. Neither matches where merges go wrong. A ten-line change to a hotspot, by someone who has never touched it, missing the file that always changes with it, deserves more attention than five hundred lines in code the author wrote last month. The CLI computes every factor from the repository's own history and shows it. You judge what to do about it. The level, when there is one, is advice for review and never a gate.

All commands run as `node ${CLAUDE_PLUGIN_ROOT}/dist/cochange.mjs risk <command>`. Output is JSON when piped. It refreshes the history cache first, and the blame cache for the touched files when placement will be computed. A first run on a large repository takes a while. `risk` exits 0 whatever the level, and non-zero only for a usage or environment error.

## Rules

- **Placement is a fact about history, never a verdict on a person.** `first-touch` means the author has not changed this file before. It says nothing about ability, and you never let it. A new contributor is `unknown`, not `first-touch`: someone with no history here may know this code from elsewhere. Never write "inexperienced", "junior", "unqualified" or the like about an author.
- **Never compare authors or build a record of a person.** Decline to rank authors by risk, to compare who has the "riskier" changes, to summarise anyone's levels over time, or to use any of this in a performance review, a coaching plan or any other assessment of a person. Say why: placement describes one change against one author's history in that code, it is deliberately never aggregated per person, and it would misread ability. Offer what you can do: assess each change on its own merits, or show where review attention is needed.
- **Placement is for the invoking user's own change by default.** When the CLI withholds it for someone else's branch, say that it was withheld and why. Do not turn it on. `cochange.risk.placement: "any"` is a team's decision to make together in `code-health.json`, so never edit the config to get it. If the user wants it for a colleague's branch, explain the setting and leave the choice to them. The impact factors are about code and are always shown.
- **The level is advice.** Never call a change safe, approved or blocked, and never present the level as a gate on merging. A level that blocks merges gets gamed, and the cheapest way to lower it is to split a change into pieces that hide the same risk.
- **Report a level only when the CLI shows one.** The CLI shows a level only where a stored backtest for this repository says the levels separate past changes. Where it shows none, there are only bands, findings and responses. Do not invent a level from the bands, and do not run or offer a backtest: it is a maintainer tool.
- **Unavailable is not low.** A factor the CLI could not compute adds nothing and says nothing about safety. Say which were unavailable.
- **You read a branch that is checked out or fetched locally.** Do not talk to a forge. Fetching a pull request, and posting your result as a comment, are the user's actions. Offer the text, do not post it.
- Names appear only through `reviewers --names`, in this conversation, as people to ask. Do not copy them into a file, a comment or a commit message.

## Workflow

1. **Establish the change.** Which branch, against which base (by default the merge base with the main branch), and whether uncommitted edits belong to it (`--worktree`). If the user's branch is not checked out and not named, ask. Run `identities check` for the change's authors and resolve anything unmapped first with the identities skill: an author's second email, left unmapped, makes an owner look like a newcomer.
2. **Gather the sibling results when the plugins are installed.** Run the complexity plugin's `diff` and the structure plugin's `check` for the same base and tip, save their JSON outside the repository, and pass each with `--evidence FILE` (repeat the flag for the second). Without them the CLI falls back to history and indentation, and says `structure-delta` is unavailable.
3. **Run `risk`**, for example `risk main..feature/x --evidence /tmp/diff.json`. Without a range it takes the branch that is checked out against the main branch. Report the level, or the bands where there is none, in one sentence with the two or three factors that drove it. Do not paste the table. The factors, their bands and what each means are in [references/factors.md](references/factors.md).
4. **Deal with completeness first.** For each `missing-co-change` file, open it and judge whether the change needs it. These files changed with the touched ones almost every other time, and this is the finding most likely to be a real defect. Say which you checked and what you concluded. A file deliberately left alone should be recorded as such.
5. **Propose the responses from the findings, cheapest first**: complete the change, split it, add tests, simplify, check the new dependency, then route review. Each finding carries its response and a `step`. Use the red-flag vocabulary where a finding matches one: a missing co-change is usually *information leakage*, and a novel coupling may be the start of it ([references/red-flags.md](references/red-flags.md)).
6. **Route review.** Run `risk reviewers [RANGE] --names` and say what each suggested reviewer is being asked to look at: the area, and why they know it. Without `--names` it lists counts only.
7. **State the limits.** Which factors were unavailable, the evidence grade (a `weak` grade means history findings are tentative), whether placement came from blame or from change familiarity alone, and, when the CLI shows a level, the stored backtest it states beside the level. When there is no level, say so and go on with the bands and findings.

When the author is the user, your stance is a pre-flight check: what to fix before asking for review. When the user is the reviewer, it is a reading guide: where to spend attention. In both, say what the numbers cannot tell: the tool shows where history says to look, and whether the code is correct is a review task.

## Commands

| Command | Use |
|---|---|
| `risk [BASE[..HEAD]] [--worktree] [--evidence FILE]...` | The impact band, placement when allowed, the level when earned, every factor with its value, band and evidence, and the findings with their responses |
| `risk explain [FACTOR]` | The rules behind the level, or one factor's definition, guidelines and the files that drove it |
| `risk reviewers [BASE[..HEAD]] [--names]` | Active developers per touched area, ranked by authorship and by changes to coupled files |

`BASE..HEAD` may name any local refs. `--no-refresh` skips the cache refreshes. `cochange explain risk-<finding>` describes a finding's rule.

## Reading what comes back

- **Impact** is a band against the repository's own merged changes, not an absolute size. A large change in a repository of large changes is ordinary. A band that is `unavailable` means too few merged changes to compare with.
- **Events** raise the impact band once: a high `missing-co-change`, any `structure-delta`, any `sensitive-paths` match. They are findings in their own right.
- **Placement** is `close`, `mixed`, `distant` or `unknown`, with a label per file. Say which labels drove it, in terms of files, never in terms of the person. [references/placement.md](references/placement.md) has the labels and the privacy rules in full.
- **Level** is `routine`, `attention` or `elevated`. It appears only where a stored backtest shows the levels separate past changes, and the CLI states that backtest beside it. Read it as advice.
- A response that rests on placement (`owner-distance`, `no-owner`, `distant-placement`) exists only when placement was computed.
