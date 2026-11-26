# Placement

Placement is how one change's authors stand to the code the change touches.

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

**A new contributor is `unknown`, not `first-touch`.** An identity is new when its first commit is within `cochange.risk.newIdentityDays` (90) or it has fewer than `newIdentityChanges` (10) changes. Someone with no history here may have years of experience with the code elsewhere, and the tool cannot tell. Say `unknown` and say why.

## Where the labels come from

- With the blame cache: the share of each touched file's lines the authors last wrote at the base. Lines held by bots, services and agents belong to nobody.
- Without it: the authors' earlier changes to the file weighted by recency, which needs only history. The output says which basis it used (`blame`, `history`, or `mixed`).
- Also shown, as counts and paths: `neighbourhood` (the authors' changes to coupled files, to the same folder and, when components are configured, to the same component), `first-touch-share`, `owner-distance` (files with a clear owner who is not an author) and `no-owner`.

## Settings and storage

- **Any change by default.** Placement is computed for whoever wrote the change. `cochange.risk.placement: "self"` computes it only when the change's authors are the invoking git identity, and withholds it for anyone else's, with the reason. `"off"` never computes it.
- **One change at a time.** No command lists placement or levels by author. No command reports per person.
- **Nothing kept.** Placement, the level and the findings that rest on it are not written to `reports/` and are not stored. The impact factors are.
- **Owners are named by `reviewers`.** `owner-distance` counts files with an owner who is not an author. `risk reviewers` names them, as people to ask.

## What you say

Say that a file is `first-touch` for the author: they have not changed it before. Say what to do: a pre-change briefing, or a review by an owner of the file.
