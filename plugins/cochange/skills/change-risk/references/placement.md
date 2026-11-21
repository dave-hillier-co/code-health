# Placement and privacy

Placement is how one change's authors stand to the code the change touches. It is the sensitive half of the assessment, because it is about a person's history, and it is bounded the way the rest of the suite bounds data about people.

## Labels

Each touched file gets one of five labels:

| Label | Meaning |
|---|---|
| `owner` | The authors last wrote a major share of the file's lines at the base (default at least 50 %) |
| `regular` | They hold a meaningful share (default at least 10 %), or changed the file several times lately |
| `occasional` | They have changed the file, but rarely or long ago |
| `first-touch` | They have never changed the file |
| `unknown` | Too little history to say: a new identity, a new file |

The change is `close` when most of its churn is in `owner` or `regular` files, `distant` when most is in `first-touch` files or no one active holds a share, `mixed` otherwise, and `unknown` when most files are unknown.

**A new contributor is `unknown`, not `first-touch`.** An identity is new when its first commit is within `cochange.risk.newIdentityDays` (90) or it has fewer than `newIdentityChanges` (10) changes. Someone with no history here may have years of experience with the code elsewhere, and the tool cannot tell. Say `unknown`, say why, and do not describe the person.

## Where the labels come from

- With the blame cache: the share of each touched file's lines the authors last wrote at the base. Lines held by bots, services and agents belong to nobody.
- Without it: the authors' earlier changes to the file weighted by recency, which needs only history. The output says which basis it used (`blame`, `history`, or `mixed`).
- Also shown, as counts and paths: `neighbourhood` (the authors' changes to coupled files and to the same folder), `first-touch-share`, `owner-distance` (files with a clear owner who is not an author) and `no-owner`.

## What bounds it

- **Self by default.** Placement is computed when the change's authors are the invoking git identity: a self-check before asking for review. It is a default, not an access control. For someone else's branch the CLI withholds it, with the reason. `cochange.risk.placement: "any"` computes it for anyone's, and `"off"` never does. That setting is a team's decision to make together, so do not change it for the user.
- **One change at a time.** No command lists placement or levels by author. `backtest` reports per factor band and per level, never per person.
- **Nothing kept.** Placement, the level and the findings that rest on it are not written to `reports/` and are not stored. The impact factors are.
- **No one is named by a factor.** `owner-distance` counts files with an owner who is not an author. Who that owner is appears only through `reviewers --names`, as someone to ask.

## What you say and do not say

Say that a file is `first-touch` for the author: they have not changed it before. Say what to do: a pre-change briefing, or a review by an owner of the file. Do not say the author is weak, risky or unprepared. Do not compare two authors, do not say who tends to produce the riskier changes, and do not summarise anyone's levels over time. If asked to rank authors, to feed this into a review of a person, or to track someone across changes, decline, give the reason above, and offer a per-change assessment instead.
