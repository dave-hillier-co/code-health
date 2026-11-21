# Change Risk Skill — Spec

A skill in the **cochange** plugin. Read [suite.md](suite.md) and [cochange.md](cochange.md) first. This skill reuses cochange's history cache, coupling and hotspots, the blame cache from [abandonment](abandonment.md), and the mapping from [identities](identities.md).

## Purpose

The skill looks at a branch before it is merged and answers two questions. How much of the codebase does this change put at risk? And how well placed is its author to make it? From the two it recommends how the change should be reviewed: how deeply, by whom, and whether it should be split or completed first.

Review effort is usually spread evenly, or by size. Neither matches where merges go wrong. A ten-line change to a hotspot that the author has never touched, missing the file that always changes with it, deserves more attention than a five-hundred-line change inside code the author wrote last month. The skill makes that difference visible from evidence the repository already holds.

It is a calculator in the sense that every factor is computed deterministically and shown. It does not predict defects, and its level is advice for review, never a gate.

## Basis

The heuristics come from research on change-level risk, adapted to what git alone can show:

- **Mockus and Weiss**, *Predicting Risk of Software Changes* (2000): size, diffusion across the system and the developer's experience predict whether a change fails.
- **Kamei et al.**, *A Large-Scale Empirical Study of Just-in-Time Quality Assurance* (2013): the change-level factor families used here. Diffusion (subsystems, folders, files, entropy), size, purpose, history (earlier developers, age, unique earlier changes) and experience (overall, recent, and in the subsystem).
- **Bird et al.**, *Don't Touch My Code!* (2011): components changed by many low-ownership contributors have more failures, which is why a change's author is compared with the code's owners.
- **Rigby et al.** (2016), as used in [abandonment](abandonment.md): code whose authors have left has nobody to review it with first-hand knowledge.
- **Tornhill**: hotspots and temporal coupling as the places where change concentrates and where files are forgotten.

These studies report associations in the projects they examined. Whether the factors separate risky changes from safe ones in a given repository is an empirical question, so the skill backtests them against that repository's own history (see [Measurement](#measurement)).

## Scope

In scope:

- Measuring a local branch against its base: what it touches, how far it spreads, and what its files' history says.
- Completeness: files that usually change with the touched files and are missing from the change.
- The author's placement: prior authorship and changes in the touched files and their neighbourhood.
- A deterministic level with every contributing factor shown, and a recommended review response.
- Reviewer suggestions, from the same evidence as abandonment's successors.
- Backtesting the factors against the repository's history.

Out of scope:

- Talking to a forge. The skill reads a branch that is checked out or fetched locally. Fetching a pull request, and posting the result as a comment, are the user's actions.
- Reviewing the code itself. The skill says where to look and who should look. Correctness review is a separate task.
- Assessing the author. Placement describes the relation between one change and its author's history in that code. It is not a measure of ability, and it is never aggregated per person (see [Privacy](#privacy)).
- Gating merges.

## Concepts

**Change under review.** The commits in `BASE..HEAD`, where `BASE` defaults to the merge base with the configured main branch. They are treated as one logical change, whatever the branch's commit granularity. `--worktree` adds uncommitted edits. Files are filtered with cochange's noise filters, so lockfiles, generated and vendored paths do not count.

**Change authors.** The mapped identities of the branch's commits. A branch can have several. Agent-authored commits are attributed to the human of record, as the identities skill records them, and the output says how much of the change carries an agent trailer.

**Factor.** One heuristic's result: a value, the evidence behind it, a band (`low`, `moderate`, `high`) and the layer that produced it. A factor that cannot be computed (no adapter, no sibling report, weak history) is reported as `unavailable`, never as `low`.

**Active developer.** As [abandonment](abandonment.md) defines it, and by the same code: a commit in the activity window (`cochange.knowledge.activityWindowMonths`, default 6) ending at the analysed commit's date, corrected by the local overrides. Reviewer suggestions, `no-owner` and the owner to ask all use it, whether or not `cochange.knowledge.enabled` is set. It is not the history window (`windowMonths`), which sets what co-change is counted over.

**Baseline population.** Past changes as they were merged, so that a branch is compared with like. A past change is the set of commits a merge commit brought in, taken together, or a squash commit, or a single commit on the main line where the repository merges neither way. The merge style is read from the main branch's first-parent history. Comparing a branch with individual commits would make every multi-commit branch look large and scattered.

**Band.** A factor's value placed against the baseline population. A value above the 75th percentile is `moderate`, and above the 90th is `high`. The comparison is strict and a value of zero is always `low`: many factors are zero for most changes, and a percentile of zero would otherwise mark every change. Bands are relative, so a large change in a repository of large changes is ordinary. A few factors are counts of specific events (a new cycle, a missing coupled file) and band on the count instead. A two-sided factor such as `age` is banded on each side and takes the higher.

**Family.** A group of factors that measure nearly the same thing. Size, spread and entropy rise together, so counting each would count one fact three times. A family counts once, at the band of its highest factor. The families are the four tables below: size and diffusion, history of the touched code, completeness, and structure and content.

**Impact.** What the change puts at risk, from the impact factors.

**Placement.** How the change's authors stand to the code it touches, per file and overall, from the placement factors.

## Impact heuristics

Each row is a factor. The history and lexical layers supply most of them, so they work in any language. Rows marked *structural* need an adapter or a sibling plugin's report, and are `unavailable` without one.

### Size and diffusion

| Factor | Signal | Why it matters |
|---|---|---|
| `size` | Lines added plus deleted, and files touched | Larger changes hide more, and review attention per line falls as size grows |
| `spread` | Change spread of the touched files (mean pairwise tree distance), with folders and components touched | A scattered change needs knowledge of several areas at once |
| `entropy` | How evenly the churn is distributed over the touched files | A change concentrated in one file is easier to follow than the same churn smeared over twenty |
| `mixed-purpose` | Renames or moves combined with content changes | The change is probably several changes, and a reviewer cannot evaluate a move and a behaviour change together |

### History of the touched code

| Factor | Signal | Why it matters |
|---|---|---|
| `hotspots-touched` | Share of the change's churn landing in files in the top hotspot percentile | Hotspots are where complexity and change meet, and where defects concentrate |
| `defect-history` | Share of each touched file's revisions that were fixes or reverts, where commit-message conventions allow it | Code that has needed fixing tends to need it again |
| `contention` | Distinct authors who changed the touched files in the recent window, by count only | Concurrent work raises the chance of semantic conflicts that a clean merge does not show |
| `age` | Touched files not changed within the stale window, and files changed within the last few days | Old code has lost its context. Very recent code is still settling. |
| `abandoned-touched` | Touched files already abandoned, or with high abandonment probability, when knowledge analysis is enabled | Nobody is left who can review these with first-hand knowledge |

### Completeness

| Factor | Signal | Why it matters |
|---|---|---|
| `missing-co-change` | Files with confidence at or above the threshold towards a touched file, with support above the minimum, that the change does not touch | The strongest single completeness signal: these files have needed changing every other time |
| `novel-coupling` | Pairs of touched files at high tree distance that have never changed together before | The change may be introducing a dependency between areas that were independent |
| `test-evidence` | Source files changed without the test files that usually change with them, and test deletions | Behaviour may have changed without tests following |

### Structure and content

| Factor | Signal | Why it matters |
|---|---|---|
| `blast-radius` | Fan-in of the touched files, and of touched exported symbols whose signature changed (*structural*). Without an adapter: the number of files with high co-change confidence towards the touched files. | A flaw in widely used code is inherited by every consumer |
| `complexity-delta` | Units that are new and over a threshold, or over a threshold and worse, from `complexity diff`. Without the complexity plugin: the change in indentation complexity of touched files. | The change is adding code that is hard to understand |
| `structure-delta` | New cycles and layer violations, from `structure check` (*structural*) | The change makes later changes more expensive |
| `sensitive-paths` | Touched files matching configured globs: migrations, authentication, build and CI configuration, public API, dependency manifests | Some paths carry consequences that no history signal captures |

## Placement heuristics

Placement is computed per touched file and then summarised. Each file gets one of five labels:

| Label | Condition |
|---|---|
| `owner` | The author last authored a major share of the file's lines at the base (default at least 50 %) |
| `regular` | The author holds a meaningful share of lines (default at least 10 %), or has changed the file several times within the recent window |
| `occasional` | The author has changed the file, but rarely or long ago |
| `first-touch` | The author has never changed the file |
| `unknown` | Too little history to say: a new identity, a new file, or weak evidence |

The factors behind the labels:

| Factor | Signal | Why it matters |
|---|---|---|
| `authorship` | Share of lines in each touched file last authored by the change's authors, from the blame cache at the base | The author is modifying code they wrote |
| `change-familiarity` | The authors' earlier logical changes to each touched file, weighted by recency | Familiarity fades, so a change from three years ago counts for less than one from last month |
| `neighbourhood` | The authors' earlier changes to files coupled with the touched files, and to the same component | Someone who knows the surroundings is better placed than a file-level count shows |
| `first-touch-share` | Share of the change's churn in `first-touch` files | The part of the change made without any history in that code |
| `owner-distance` | Touched files that have a clear owner who is not among the change's authors | Changes by low-ownership contributors to owned code are where the ownership research finds more failures, and the owner is the obvious reviewer |
| `no-owner` | Touched files with no active developer holding a meaningful share | Neither the author nor any reviewer has first-hand knowledge |

A new contributor's placement is `unknown`, not `first-touch`. Someone with no history in the repository may have years of experience with the code elsewhere, and the tool cannot tell. An identity is new when its first commit falls within the configured period (default 90 days) or it has fewer than the configured number of changes (default 10).

Placement needs the blame cache. Building it does not need `cochange.knowledge.enabled`, which gates the abandonment analysis and not line authorship. Where the blame cache is absent, `authorship` is `unavailable` and the labels come from `change-familiarity` alone, which needs only history.

## Level and response

Impact and placement are each summarised to a band, by rules that `cochange risk explain` prints in full:

- **Impact** starts from a score. Each family that the history layer can compute contributes the band of its highest factor (low 0, moderate 1, high 2), and the score is the sum. The score is then banded against the baseline population's own scores, by the same strict percentiles. Impact is therefore relative too: by construction no more than a quarter of changes are `moderate` or above, and no more than a tenth are `high`, however many factors there are.
- **Events raise it.** Three findings are events and not positions in a distribution: a high `missing-co-change`, any `structure-delta`, and any `sensitive-paths` match. Each is reported as a finding, and together they raise the impact band by one step, once.
- **Placement** is `close` when most of the churn is in `owner` or `regular` files, `distant` when most is in `first-touch` files or `no-owner` is high, and `mixed` otherwise. With mostly `unknown` files it is `unknown`.

The level comes from the two together:

| | Placement close | Placement mixed or unknown | Placement distant |
|---|---|---|---|
| **Impact low** | `routine` | `routine` | `attention` |
| **Impact moderate** | `routine` | `attention` | `elevated` |
| **Impact high** | `attention` | `elevated` | `elevated` |

Rules, not fitted weights, set the level, so anyone can see why a change got it.

**No level without a backtest.** Until `cochange risk backtest` has run on the repository and shows that the levels separate past changes, `risk` reports the bands, findings and responses, and no level. Once it has, the output states the backtest result beside the level.

The level matters less than the response it leads to. Each finding carries a suggested response:

| Finding | Suggested response |
|---|---|
| `missing-co-change` | Open the named files and decide, for each, whether it needs changing. Record the ones deliberately left alone. |
| `mixed-purpose` | Split the change: moves and renames first, as their own commits or their own merge request |
| `size` or `spread` high | Split along the components touched, when they can merge independently |
| Distant placement on hotspot or high fan-in files | Review by an owner of those files, and a pre-change briefing (`cochange brief`) for the author |
| `owner-distance` | Add the owner as a reviewer |
| `no-owner` or `abandoned-touched` | Characterisation tests before the change, and a short note capturing what was learned |
| `test-evidence` | Add or update the tests that usually change with these files, or say why not |
| `complexity-delta` | Run `complexity explain` on the named units and simplify before merge |
| `structure-delta` | Review the new dependency with the structure skill before it lands |
| `novel-coupling` | Confirm the new dependency is intended. If it is, consider whether the files belong closer together. |

## CLI

Subcommands of the cochange CLI. Every one supports `--json` with a versioned schema.

| Command | Output |
|---|---|
| `cochange risk [BASE[..HEAD]] [--worktree] [--evidence FILE...]` | The level (when backtested), the impact and placement bands, every factor with its value, band, evidence and source, and the findings with their responses |
| `cochange risk explain [FACTOR]` | The rules behind the level, or one factor's definition, thresholds and the files that drove it |
| `cochange risk reviewers [BASE[..HEAD]] [--names]` | Suggested reviewers per touched area: active developers ranked by authorship and by changes to coupled files |
| `cochange risk backtest [--since DATE]` | For the baseline population: each history-layer factor's band and the level, against whether the change was later reverted or fixed |

`risk` is advisory and exits 0 whatever the level. It exits non-zero only on usage and environment errors.

## Privacy

Impact factors are about code and are on by default. Placement is about a person's history, so it is bounded the way the rest of the suite bounds data about people.

- **Self by default.** Placement is computed when the change's authors match the invoking user's own git identity: a self-check before asking for review. This is a default, not an access control, since anyone can set a git identity. Computing it for someone else's branch needs `cochange.risk.placement: "any"` in the repo config, which is a team's decision to make together.
- **One change at a time.** There is no command that lists placement or levels by author, and `backtest` reports per factor and per level, never per person.
- **Nothing kept.** Placement is not written to `reports/` and is not stored. Nor is the level, since placement could be read back from it. The impact factors are.
- **Reviewer suggestions name active developers only**, as recommended reviewers, under the same rule as `successors --names`. Without `--names`, areas are listed with counts.
- **Contention and ownership use counts.** No factor's evidence names a person other than the change's own authors and, with `--names`, suggested reviewers.

The skill describes placement as a fact about history. `first-touch` means the author has not changed this file before. It says nothing about their ability, and the skill does not let it. It declines to compare authors, to summarise anyone's levels over time, or to use the results in an assessment of a person, and says why.

## Skill

Skill name `change-risk`, in `plugins/cochange/skills/change-risk/`. It triggers on requests to assess a branch, merge request or pull request before review or merge: "how risky is this change", "what should the reviewer look at", "who should review this", "is this ready for review".

Workflow:

1. Establish the change: the branch, its base, and whether uncommitted edits belong to it. Refresh the history cache if it is behind, and the blame cache if placement will be computed. Run `cochange identities check` for the change's authors and resolve anything unmapped first: an author's second email, left unmapped, makes an owner look like a newcomer.
2. When the complexity or structure plugin is installed, run `complexity diff` and `structure check` for the branch and pass their JSON with `--evidence`. Run `cochange risk`. Report the level, or the bands where there is no backtested level, in one sentence with the two or three factors that drove it, not the whole table.
3. Deal with completeness first. For each `missing-co-change` file, open it and judge whether the change needs it. This is the finding most likely to be a real defect.
4. Propose the responses from the table, cheapest first: complete the change, split it, add tests, then route review.
5. For review routing, run `reviewers`, and say what each suggested reviewer is being asked to look at.
6. State the limits: which factors were `unavailable`, the evidence grade, and what the backtest says about how well the levels have separated changes in this repository.

When the author is the user, the skill's stance is a pre-flight check: what to fix before asking for review. When the user is the reviewer, it is a reading guide: where to spend attention. The skill uses the [red-flags](../../shared/red-flags.md) vocabulary where a finding matches one. A missing co-change is usually *information leakage*, and a novel coupling may be the start of it.

## Composition

The skill works from history alone. Results from sibling plugins reach it in two ways, and both are named in `inputs`:

- **Per-branch results are passed in.** `complexity diff` and `structure check` describe one branch, so they are not reports in the suite's sense, which are full runs stamped with HEAD. The skill runs them and hands their JSON to `cochange risk --evidence`. The CLI folds them in as `complexity-delta` and `structure-delta`, and never invokes another plugin itself.
- **Fan-in comes from a report.** `blast-radius` reads locality's report when it is present and stamped with the current HEAD ([suite.md](suite.md#shared-caches)).
- **`abandoned-touched` reads abandonment's report.** A configured `abandonment simulate` run on a clean tree stores `reports/cochange.abandonment.simulate.json`: every file with its abandoned flag and probability, never a person. When it is stamped with the change's tip and the current config and overrides, the factor reads it and `inputs.abandonment` names it. Otherwise the factor is measured from the blame cache at the change's base.
- The blame cache supplies placement.

Without them, the lexical and history fallbacks in the tables apply, or the factor is `unavailable`.

## Measurement

| Measure | What it shows | Role |
|---|---|---|
| Backtest separation: the revert and fix rate of past changes at each level | The levels mean something in this repository | Model validity |
| Per-factor separation: the same rate by band, for each factor | Which heuristics carry signal here, and which to turn off | Model validity |
| Share of `missing-co-change` findings where the named file was then edited before merge, or within the follow-up window after it | The completeness signal finds real omissions | Primary outcome |
| Follow-up fix rate of merged changes over matching windows, before and after adoption | Changes land more complete | Primary outcome |
| Share of changes at `elevated` | The level is not inflating into noise | Gaming check |

A change counts as followed by trouble when it is reverted, or when a fix commit touches the files it changed within the follow-up window (default 30 days). The file-level test over-counts in busy files, so each level's rate is compared with the base rate for the same files, not with zero. Fix commits are found by commit-message convention, so repositories without one get reverts only, and the backtest says so. If the levels do not separate past changes, the skill reports that and presents the factors as observations, without a level.

The backtest has three constraints that keep it honest and affordable:

- **As of each change.** Hotspots, coupling and bands for a past change are computed from the history before it. Scoring it with today's figures would leak the outcome, since a file that was later fixed is a hotspot now.
- **History layer only.** Structural factors would need a parse of every past change, so the backtest leaves them out and says so.
- **Placement without blame.** A blame at every past commit is not affordable. The backtest places past authors by `change-familiarity` and `neighbourhood`, which need only history, and reports results per level and per factor, never per person.

## Testing

- Fixture repositories with scripted branches: a complete change, one missing a coupled file, a mixed move and edit, a first-touch change to a hotspot, and a branch by a new identity.
- Golden output for `risk`, with every factor's value and band.
- Property tests for bands: no more than a quarter of the baseline population is `moderate` or above on any factor or on impact, no more than a tenth is `high`, and a zero value is always `low`.
- Backtest fixtures that fail if a later commit can change an earlier change's score.
- Placement labels checked against hand-computed blame shares on small fixtures.
- Skill evals: it leads with completeness; it reports `unknown`, not `first-touch`, for a new contributor; it declines to rank authors or summarise a person's levels; it does not compute placement for another person's branch unless config allows it.

## Configuration

In `cochange.risk`:

- Main branch for the default base.
- Percentiles for the `moderate` and `high` bands, and thresholds for the count-based factors.
- Confidence and support thresholds for `missing-co-change`.
- Ownership shares for `owner` and `regular`, the recency weighting, and what counts as a new identity.
- Sensitive path globs.
- Fix and revert commit-message patterns, and the follow-up window.
- `placement`: `self` (default), `any` or `off`.
- Factors to disable.

## Decisions

- **In the cochange plugin, as a skill.** Almost every factor is a history query the plugin already answers. It triggers in a different situation from the other skills (a branch about to merge), so it is its own skill.
- **Advice, not a gate.** A level that blocks merges gets gamed, and the cheapest way to lower it is to split a change into pieces that hide the same risk. The response table is the product.
- **Rules before weights.** A fitted model would predict better and explain worse. The backtest keeps the rules honest, and a factor that carries no signal in a repository can be turned off.
- **Relative bands, against merged changes.** Absolute thresholds for size or spread do not transfer between repositories, and a branch is only comparable with past branches.
- **Families, and a banded score.** Counting correlated factors separately, or raising the level when any one of many factors is high, would put most changes at the top level. A level most changes share tells a reviewer nothing.
- **Placement is self by default.** The most useful and least invasive use is an author checking their own change. Using it on colleagues' branches is a team choice, not a default.
- **Unavailable is not low.** A factor the tool could not compute must not make a change look safer.

## Open questions

- Whether to fit weights from the backtest once the rules are shown to separate changes, and whether the gain is worth the loss of a level anyone can derive by hand.
- Whether fix-inducing changes should be traced line by line (the SZZ approach). The backtest uses the file-level approximation, which is cheaper and over-counts.
- How to treat a change authored mostly by an agent. The human of record may be an owner of the code and still not have read the diff.
- Whether review history (who has reviewed these files) should count towards placement. It is real knowledge, but it is not in git.

## Milestones

1. Change extraction against a base, with size, spread, entropy and `missing-co-change`.
2. The remaining history factors, bands from the repository's own history, and `explain`.
3. `backtest`, so the factors are checked before a level is shown to anyone.
4. Placement from the blame cache, with the privacy gating.
5. The level, findings and responses, and `reviewers`.
6. Skill and evals, including the decline cases.
7. Composition with complexity, structure and locality.
