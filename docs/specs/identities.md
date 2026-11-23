# Identity Resolution Skill — Spec

A skill in the **cochange** plugin. Read [suite.md](suite.md) and [cochange.md](cochange.md) first. This skill is a prerequisite for [abandonment](abandonment.md) and for author-based logical change grouping.

## Purpose

The skill builds a reviewed `.mailmap` that maps the many names and emails people commit under to one identity each, and marks bots and service accounts. Any analysis that counts people depends on it. Without it, one person with a work and a personal email looks like two half-time contributors, and their departure looks like a smaller loss than it is.

Conventions are strong (same name, `first.last@` across domains, GitHub noreply addresses), but they cannot be applied automatically. Two different people can share a name, one person can change their name, and a shared or service account can look like a person. So the tool proposes, the agent judges, and the user confirms what the evidence cannot settle.

## Scope

In scope:

- Listing every raw identity (name, email pair) in history, with activity evidence.
- Proposing clusters of identities likely to be the same person, with the evidence for each link.
- Classifying bots, CI and service accounts, and agent-authored commits.
- Writing and validating `.mailmap`, and remembering rejected merges so they are not proposed again.

Out of scope:

- Looking people up outside the repository: no web searches, no directory lookups, no profile fetching. Evidence comes from git history only.
- Inferring anything about people beyond "these identities are the same contributor".

## Evidence

The CLI computes link evidence between pairs of raw identities. Each link carries the signals that fired, so the agent and user can see why it was proposed:

| Signal | Example | Strength |
|---|---|---|
| Exact email match after normalisation (case, `+tag`) | `Jo@x.com` / `jo+git@x.com` | Strong |
| Two GitHub noreply addresses with the same username or numeric id | `1234+jsmith@users.noreply.github.com` / `jsmith@users.noreply.github.com` | Strong |
| GitHub noreply username matches another identity's email local part or name, written as all its parts joined, as first initial and last name, as first name and last initial, or as first initial and the first 6 or more letters of a longer last name (`dvakulen` for `Dmitry Vakulenko`) | `1234+jsmith@users.noreply.github.com` / `jsmith@corp.com`, `mazdakb` / `Mazdak Badakhshan` | Medium: the same evidence as a shared local part |
| Same email local part inside one organisation's domain, where one host is a machine in the other (local part of at least 5 characters, no mailbox provider) | `sbykov@microsoft.com` / `sbykov@pc12.corp.microsoft.com` | Strong: git writes such an address when none is configured |
| Same normalised name (case, diacritics, whitespace, `_`, a parenthesised affiliation, `Last, First` order) | `José Pérez` / `jose perez`, `Jo Park (Contoso)` / `Jo Park` | Medium: common names collide |
| Name derivable from email local part | `John Smith` / `j.smith@`, `jsmith@`, `john.smith@` | Medium |
| Same email local part, different domains | `jsmith@corp.com` / `jsmith@gmail.com` | Medium |
| Handover in time: one identity stops as the other starts, on overlapping files | Personal email until March, work email from March | Supporting |
| Exclusive pairing as author and committer: each identity appears on commits only with the other | Author `jo@home`, committer `jo@corp`, neither ever paired with anyone else | Supporting. Plain co-occurrence is not evidence, because a maintainer who applies, rebases or merges a patch is the committer on someone else's commit. Platform committers such as `GitHub <noreply@github.com>` are ignored. |
| Same signing key across identities, where commits are signed | GPG or SSH key fingerprint | Supporting alone: it links no one by itself, because one key can sit on a shared machine or a team account. Strong beside any medium signal. A key held by more than three identities is ignored, and so is a platform key: GitHub's web-flow key signs every user's web-UI commits. |
| Simultaneous activity on disjoint areas with the same name | Two `Alex Kim`s active in the same week in unrelated folders | Counter-evidence |

Some medium signals are strong together. These pairs are proposed as strong:

- the same normalised name and a GitHub noreply login that matches the other identity (its local part or its name written as a username);
- the same normalised name and the same email local part on different domains;
- a shared signing key and any medium signal.

A name alone, a local part alone and a login alone stay medium.

A set of identities that strong links settle in groups, and that medium links join into a wider set, is proposed twice: each strong group as a strong cluster, and the wider set as a medium cluster or chain. The settled part does not wait for the rest. After the strong groups are applied, `propose` shows the wider question with each group as one identity.

Clusters are built from links, but **never transitively merged on weak links alone**. A chain of medium links (A~B by name, B~C by local part) is shown as a chain for review, not as one cluster.

### Non-person classification

- **Bots**: `[bot]` suffix, known bot emails (dependabot, renovate, github-actions), and configurable patterns.
- **Service and CI accounts**: generic names (`build`, `jenkins`, `release`), and commits that are only version bumps or merges.
- **Coding agents**: classified as kind `agent` by default, with no decision needed. A commit authored as `Claude <noreply@anthropic.com>` (only that address: a person with another address at `anthropic.com` is not an agent), a GitHub Copilot, Cursor or Devin identity (the Copilot and `devin-ai-integration` noreply addresses, `cursoragent@cursor.com`) is an agent's. A `Co-Authored-By` trailer that names an agent is listed by `classify` as an agent, already decided when its address matches one of those. A decision of kind `person` overrides the default. Agents are not developers: they are not in the population of people, they are not counted in knowledge loss, and the lines they hold belong to nobody. A commit an agent authored whose message has a `Co-Authored-By` trailer naming a person (not an agent) is attributed to that person, for lines and for activity. The first such trailer is used. An agent's commits are still changes: they are not dropped from change grouping.

## Output

The skill writes two things:

- **`.mailmap`** in git's standard format, so git itself, and every tool in the suite, honour it: `git log`, `git shortlog` and `git blame` all apply it.
- **Decisions file** recording what `.mailmap` cannot express: rejected merges ("these are different people"), and classifications (bot, service, agent). It lives at `.code-health/local/identity-decisions.json` by default, outside the cache, because it cannot be regenerated ([suite.md](suite.md#local-state)).

Where they go is a decision for the team, and the skill asks the first time:

- **Committed** `.mailmap` (common practice, and it reveals nothing beyond what history already shows) plus a committed decisions file at `.code-health/identity-decisions.json`, so the whole team shares one reviewed mapping.
- **Local only**: the mailmap goes to `.code-health/local/mailmap`, passed to git with `-c mailmap.file=…`, for people who would rather not commit identity mappings.

The CLI resolves identities the same way in both modes.

## CLI

Subcommands of the cochange CLI. Every one supports `--json`.

| Command | Output |
|---|---|
| `cochange identities list [--unmapped]` | Raw identities with commit counts, first and last seen, the top folders they touched and their current mapping |
| `cochange identities propose` | Proposed clusters and chains, each link with its signals and strength. Excludes recorded rejections. Deterministic ordering. |
| `cochange identities classify` | Proposed bot, service and agent classifications with the pattern that matched |
| `cochange identities apply --from FILE` | Writes `.mailmap` entries and decisions from an agent-prepared, user-approved decisions JSON. Dry run by default, `--apply` to write. |
| `cochange identities check` | Validates the mapping: unmapped identities with significant activity, emails mapped to two people, and clusters with counter-evidence. Exits 1 on conflicts, not on unmapped identities. |

`apply` preserves existing `.mailmap` entries and comments, sorts new entries deterministically and never removes a line without the user asking.

## Skill

Skill name `identities`, in `plugins/cochange/skills/identities/`. It triggers on mailmap, duplicate authors and contributor lists. The abandonment skill invokes it when `identities check` reports significant unmapped or conflicting identities. Its guideline is unmapped identities holding more than a configured share of lines at HEAD.

Workflow:

1. Run `check`. If the mapping is clean, stop.
2. Run `propose` and `classify`.
3. Accept **strong** links without asking, and list them in the summary for the user to see.
4. Decide **medium** links with judgement: accept when several independent signals agree and there is no counter-evidence; otherwise ask.
5. Ask the user about the rest, in batches, one question per ambiguous cluster, showing the evidence (names, emails, active dates and areas). Never ask about strong links, and never guess on a lone name match.
6. Record rejections, so the same pair is not proposed again.
7. Run `apply` as a dry run, show the diff, apply on approval, and re-run `check`.

Rules for the agent:

- History is the only evidence. It does not look people up anywhere else.
- When in doubt, keep identities separate. A missed merge understates one person's knowledge. A wrong merge invents a person and corrupts every downstream number.
- Results go to the user only, and identity data is not included in reports from other skills unless those skills' own rules allow it.

## Privacy

The rest of the suite keeps data about people off by default. This skill is the stated exception, because it cannot map identities without showing them.

- It shows the names and emails `git log` already shows, plus activity dates and areas as evidence for a merge. It shows nothing else about a person.
- Its commands run through this skill or on an explicit request. No other skill's workflow includes them, except the `check` the abandonment skill runs, which reports counts and shares only.
- Identity output is never written to `reports/`, so no other plugin can read it.

## Measurement

- Share of HEAD lines (and of commits in the analysis window) attributed to mapped identities. It should be close to 100 % before abandonment results are trusted, and the abandonment skill reports it alongside its results.
- Conflicts and counter-evidence clusters from `check`, which should be zero.

## Testing

- Fixture repositories with scripted identity variations: email changes, noreply addresses, name formats, two different people with the same name, bots and agent trailers.
- Golden output for `propose`: links, signals and ordering.
- `apply` round-trips an existing `.mailmap` with comments unchanged.
- Skill evals: it asks about a lone same-name pair rather than merging; it does not ask about strong links; it never searches the web for a person.

## Configuration

In `cochange.identities`:

- Mapping location (committed or local).
- Service patterns (`servicePatterns`). Bot patterns are the shared `history.botPatterns` setting, which `cochange.botPatterns` may override. Cochange's noise filters and the abandonment skill read both, together with the classifications in the decisions file.
- The unmapped-share guideline (`unmappedShareGuideline`) above which the abandonment skill uses this one first, and the `significantCommits` guideline.
- Agent trailer patterns.

## Resolved definitions

Numbers here are guidelines or floors, as in [cochange.md](cochange.md#resolved-definitions). They order and label evidence and are printed with it. None of them removes an identity from a report. CodeScene maps identities from an explicit `.mailmap` or a hand-merged alias list and never merges automatically, so the defaults are conservative: a missed merge costs a review, a wrong merge corrupts results.

**What `check` does with each finding.** Exit 1 is for conflicts, which are what the table above lists: an address under two mapped identities, a merge a recorded decision rejects, and joined identities (or pending proposals) with counter-evidence. These are errors in the mapping that the user asked `check` to validate, so `check` gates on them. Unmapped identities are never a failure. They are all listed, ordered by lines at HEAD, then window commits, with `aboveGuideline` set when the identity holds lines or has at least `significantCommits` (default 3, a judgement call) commits in the window. CodeScene treats unresolved aliases as a data-quality warning, and this matches it.

**Line ownership.** `check` reads line ownership from the shared blame cache, refreshed first unless `--no-refresh` is given, with the options the abandonment analysis uses (`-w -M -C` unless `cochange.knowledge.copyDetection` is false, and the ignore-revs file). Its mapped share therefore equals the one abandonment reports for the same commit and options. It does not need `cochange.knowledge.enabled`, because it reads line counts per commit and no analysis of people. `headLines.unknownFiles` counts authored files the cache holds no right blame for (zero after a refresh), and their lines are not counted.

**Mapped share.** An identity is unmapped while any proposal that is not rejected names it. `mappedShare` is the share of people's lines held by identities no such proposal names, with bots, services and agents left out of the denominator. A proposal that is pending and wrong therefore counts as unresolved. An identity that no proposal names counts as mapped without a mailmap entry, because nothing links it to anyone: an author with one address is never penalised. An identity that a strong proposal names counts as unmapped until the proposal is applied, because the mailmap is what every other command reads. `unmappedStrong` is the part of the unmapped lines held by identities a strong proposal names. It is the part that needs no decision, so `mappedShare` plus the share `unmappedStrong` gives is what the mapping reaches once the strong proposals are applied. `needsIdentityReview` is true when the unmapped share exceeds `unmappedShareGuideline` (default 5 percent, a judgement call). It is a guideline for deciding whether to use this skill first, and the measured share is printed beside it.

**Evidence constants.** A handover is a gap of at most 90 days or an overlap of at most 14 days between one identity's last commit and the other's first. Counter-evidence is computed only for links that are not strong, whether a strong signal or a strong combination makes them so, since strong evidence outranks it. `propose` and `check` use this one rule: `check` does not compare a pair of joined identities that the same name and address evidence would propose as strong, so a join that `propose` marked strong never fails `check` for activity in the same weeks in different areas, which one person working across a repository shows. A joined pair with no strong link, such as one joined by hand against the evidence, is still compared. Simultaneous activity is compared by week, in areas given by the first two folders of each path. A shared signing key is a supporting signal that makes a link strong only beside a medium signal, and platform keys are ignored as in the table. Both day counts are judgement calls. They decide which proposals the agent is shown, and never which are applied.

**Canonical identity.** `propose` suggests one member as `suggestedCanonical`: the member whose name looks like a personal name (two or more words, all letters) comes first, so `Dmitry Vakulenko` is suggested over `dVakulen`; when no member has one, the members that carry the name most members share come first. Then a member with an address that is not a GitHub noreply address, then the most recently active, then the one with most commits, then the identity as written. It is a suggestion the user may overrule. `apply` never picks one. Each merge in the approved decisions file names its canonical identity and its aliases. Rejections and classifications are matched on the identity as written, ignoring case.

**Mailmap source.** Identity commands read the working-tree `.mailmap` and the local mailmap through `git check-mailmap`, so an uncommitted mapping shows at once. Every other command reads the `.mailmap` blob at the analysed ref plus the local mailmap, so reports stay reproducible at a commit. Where a decision is written follows `--location`, then config, then the files present. With none of those, `apply` refuses and tells the agent to ask the user.

**Non-person filtering.** `filtersApplied.botPatterns` lists the configured patterns. `filtersApplied.nonPerson` lists the built-in bot patterns and service names, the configured service patterns and the number of reviewed decisions. Commits dropped by any of them are counted in `dropped.botCommits`. Commits by agents are not dropped.

## Open questions

- Whether to read `Signed-off-by` and other trailers as extra link evidence.
- How to handle someone who changed their name. Mapping to the current name is respectful and correct, and the skill should never surface the old name in its output beyond the mailmap entry itself.
