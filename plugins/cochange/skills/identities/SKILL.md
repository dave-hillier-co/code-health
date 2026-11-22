---
name: identities
description: Builds a reviewed .mailmap that maps the many names and emails people commit under to one identity each, and marks bots, services and agent commits. Use when someone mentions a mailmap, duplicate or split authors, a wrong contributor list or shortlog, or one person counted twice. Also use when `cochange identities check` reports unmapped or conflicting identities, as the abandonment analysis does before it trusts a count of people. It uses git history only and never looks anyone up elsewhere.
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cochange.mjs *)
---

# Identity resolution

Every analysis that counts people depends on one person being one identity. A person with a work and a personal email looks like two half-time contributors, and their leaving looks like a smaller loss than it is. The CLI computes the evidence. You judge it. The user confirms what the evidence cannot settle.

All commands run as `node ${CLAUDE_PLUGIN_ROOT}/dist/cochange.mjs identities <command>`. Output is JSON when piped. Lists stop at 20 rows: pass `--limit all` when you need the rest.

## Rules

- **History is the only evidence.** Do not search the web, read profile pages, run `gh api` or `curl`, or look anyone up in a directory. If the history cannot settle a pair, ask the user.
- **When in doubt, keep identities separate.** A missed merge understates one person's knowledge. A wrong merge invents a person and corrupts every number downstream.
- **Results go to the user only.** Show names, emails, dates and areas to the user in this conversation, because the work cannot be done without them. Do not copy identity data into any report, file, issue or commit message, and do not carry it into another skill's output. The only things that leave this skill are the `.mailmap` and the decisions file the user approved.
- **Never write to the mailmap or decisions file except through `apply`.** `apply` keeps every existing line and comment and never removes one. If the user wants a line removed, they edit the file.
- Someone who changed their name is mapped to the current name. Never repeat the old name in what you say beyond the mailmap entry itself.

## Workflow

1. **Check.** Run `identities check`. If it exits 0 and `measurement.needsIdentityReview` is false, the mapping is settled: say so, with the mapped share, and stop. Exit 1 means conflicts: read each finding before going on.
2. **Gather.** Run `identities propose --limit all` and `identities classify`.
3. **Strong links: accept without asking.** A cluster whose `strength` is `strong` is joined by an identical address, a shared GitHub noreply username or id, or one signing key. Add it to the decisions you prepare and list it in your summary. Never ask the user about a strong link.
4. **Medium links: judge.** Accept a medium cluster when several independent signals agree (for example a derivable name, a shared local part and a handover in time) and `counterEvidence` is false. Otherwise ask. Read [references/evidence.md](references/evidence.md) for what each signal is worth and when it misleads.
5. **Ask about the rest**, in batches. One question per ambiguous cluster, showing the evidence: both names and emails, active dates and areas. Offer the options "same person", "different people" and "not sure, leave separate". Never guess on a lone same-name pair, and never merge a cluster that has counter-evidence on your own judgement. A `chain` is never one cluster: ask about each link separately.
6. **Record rejections.** When the user says two identities are different people, put the pair in `rejectedMerges`, so it is not proposed again.
7. **Record classifications** that `classify` proposes and the user agrees with. A human whose name looks like a service gets `kind: "person"`.
8. **Apply.** Write the decisions JSON ([references/decisions-file.md](references/decisions-file.md) has the format) outside the repository, run `identities apply --from FILE` as a dry run, show the user the rows it would add, and run it again with `--apply` on their approval. Then re-run `identities check` and report the result.

## Where the mapping goes

The first time, `apply` stops with a message asking where the mapping lives, unless the config or existing files already say. Ask the user, and explain the two choices plainly:

- **Committed** (`--location committed`): a `.mailmap` at the repository root, which git, `git shortlog` and `git blame` all honour, plus `.code-health/identity-decisions.json`. The whole team shares one reviewed mapping. A `.mailmap` reveals nothing beyond what the history already shows.
- **Local only** (`--location local`): `.code-health/local/mailmap` and `.code-health/local/identity-decisions.json`, ignored by git, for people who would rather not commit identity mappings. The CLI passes the file to git itself, so analyses see it.

After that, the choice is found from the files present. To pin it, set `cochange.identities.location` in `code-health.json`.

## Bots, services and agents

`classify` proposes three kinds, each with the pattern that matched:

- **bot**: a `[bot]` suffix or a known bot address (dependabot, renovate, github-actions), or a configured pattern.
- **service**: a generic name such as `build`, `jenkins` or `release`, or an account whose commits are only version bumps or merges.
- **agent**: a `Co-Authored-By` trailer naming an AI agent. The human author or committer stays the person of record. The trailer is only recorded.

Bots, services and agents are left out of the population of people and out of every proposal. Bot and service patterns are configured in one place, `cochange.identities.botPatterns` and `servicePatterns` in `code-health.json`, and cochange's noise filters read them from there together with the decisions file.

## Reading the measurement

`check` reads line ownership from the blame cache with the same options as abandonment, so the two shares agree. It reports how much of the code the mapping has settled: the share of lines at HEAD and of commits in the analysis window held by identities that no proposal still names, with bots and services counted separately. It should be close to 100 percent before any abandonment result is trusted. Report it alongside whatever you do next. When `needsIdentityReview` is true, unmapped identities hold more than the guideline `cochange.identities.unmappedShareThreshold` percent of the lines. The measured share is printed beside it. Below the guideline the unmapped identities are still listed.

## Commands

| Command | Use |
|---|---|
| `identities check` | Conflicts, every unmapped identity (those holding lines or with many commits first, marked `aboveGuideline`), and the measurement. Exit 1 on conflicts only. |
| `identities list [--unmapped]` | Every identity as written, with commits, dates, top areas and current mapping. |
| `identities propose` | Clusters and chains with each link's signals and strength. Recorded rejections are left out. |
| `identities classify` | Bot, service and agent candidates with the pattern that matched. |
| `identities apply --from FILE [--location committed\|local] [--apply]` | Write mailmap entries and decisions. Dry run unless `--apply`. |
