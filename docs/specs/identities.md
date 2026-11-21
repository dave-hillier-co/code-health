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
| GitHub noreply username matches another identity's email local part or name | `1234+jsmith@users.noreply.github.com` / `jsmith@corp.com` | Strong |
| Same normalised name (case, diacritics, whitespace, `Last, First` order) | `José Pérez` / `jose perez` | Medium: common names collide |
| Name derivable from email local part | `John Smith` / `j.smith@`, `jsmith@`, `john.smith@` | Medium |
| Same email local part, different domains | `jsmith@corp.com` / `jsmith@gmail.com` | Medium |
| Handover in time: one identity stops as the other starts, on overlapping files | Personal email until March, work email from March | Supporting |
| Co-occurrence as author and committer on the same commits | Author `jo@home`, committer `jo@corp` | Strong |
| Same signing key across identities, where commits are signed | GPG or SSH key fingerprint | Strong |
| Simultaneous activity on disjoint areas with the same name | Two `Alex Kim`s active in the same week in unrelated folders | Counter-evidence |

Clusters are built from links, but **never transitively merged on weak links alone**. A chain of medium links (A~B by name, B~C by local part) is shown as a chain for review, not as one cluster.

### Non-person classification

- **Bots**: `[bot]` suffix, known bot emails (dependabot, renovate, github-actions), and configurable patterns.
- **Service and CI accounts**: generic names (`build`, `jenkins`, `release`), and commits that are only version bumps or merges.
- **Agent-authored commits**: commits with `Co-Authored-By` trailers naming an AI agent. The human author or committer is the person of record, and the trailer is recorded so the abandonment analysis can treat those lines as the open question there decides.

## Output

The skill writes two things:

- **`.mailmap`** in git's standard format, so git itself, and every tool in the suite, honour it: `git log`, `git shortlog` and `git blame` all apply it.
- **Decisions file** recording what `.mailmap` cannot express: rejected merges ("these are different people"), and classifications (bot, service, agent). It lives at `.cache/code-health/identity-decisions.json` by default.

Where they go is a decision for the team, and the skill asks the first time:

- **Committed** `.mailmap` (common practice, and it reveals nothing beyond what history already shows) plus a committed decisions file at `.code-health/identity-decisions.json`, so the whole team shares one reviewed mapping.
- **Local only**: the mailmap goes to `.cache/code-health/mailmap`, passed to git with `-c mailmap.file=…`, for people who would rather not commit identity mappings.

The CLI resolves identities the same way in both modes.

## CLI

Subcommands of the cochange CLI. Every one supports `--json`.

| Command | Output |
|---|---|
| `cochange identities list [--unmapped]` | Raw identities with commit counts, first and last seen, the top folders they touched and their current mapping |
| `cochange identities propose` | Proposed clusters and chains, each link with its signals and strength. Excludes recorded rejections. Deterministic ordering. |
| `cochange identities classify` | Proposed bot, service and agent classifications with the pattern that matched |
| `cochange identities apply --from FILE` | Writes `.mailmap` entries and decisions from an agent-prepared, user-approved decisions JSON. Dry run by default, `--apply` to write. |
| `cochange identities check` | Validates the mapping: unmapped identities with significant activity, emails mapped to two people, and clusters with counter-evidence. Exits 1 on conflicts. |

`apply` preserves existing `.mailmap` entries and comments, sorts new entries deterministically and never removes a line without the user asking.

## Skill

Skill name `identities`, in `plugins/cochange/skills/identities/`. It triggers on mailmap, duplicate authors and contributor lists. The abandonment skill invokes it when `identities check` reports significant unmapped or conflicting identities. Its threshold is unmapped identities holding more than a configured share of lines at HEAD.

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
- Additional bot and service patterns.
- The unmapped-share threshold that makes the abandonment skill invoke this one.
- Agent trailer patterns.

## Open questions

- Whether to read `Signed-off-by` and other trailers as extra link evidence.
- How to handle someone who changed their name. Mapping to the current name is respectful and correct, and the skill should never surface the old name in its output beyond the mailmap entry itself.
