# Complexity in CI and pre-commit

`check` is a ratchet, not a gate. A hard threshold on an existing codebase produces a backlog nobody burns down, or a
blanket waiver. `check` compares against a base revision instead, so only functions that are new or got worse can fail.

```
node ${CLAUDE_PLUGIN_ROOT}/dist/complexity.mjs check --json
```

In CI the plugin directory is wherever the bundle is checked out: call
`node <path-to-plugin>/dist/complexity.mjs check` directly.

## What fails

`check` measures the functions of the files that differ from the base, on both sides, and matches them by identity
(`path#Qualified.name`). It fails with exit code 1 when:

- a **new** function is over a threshold on any gated metric (`new`), or
- an **existing** function is over a threshold on a metric and that metric rose by more than `complexity.delta`
  (`worsened`). The default delta is 0, so any rise fails.

A function that stays under its thresholds never fails, however much it changed. A function over a threshold that did
not get worse never fails either. Functions in files the change did not touch are not read.

A function that was renamed or moved is matched to the old one by body similarity (`moveSimilarity`, default 0.8). It is
compared with its old self, so moving a function unchanged passes and moving it while making it worse fails. A function
rewritten beyond recognition has no match and counts as new, so it must be under the thresholds.

Each result row names the function, the `finding`, the `metric`, the values before and after, and the threshold. The
`summary` counts what was compared. Changed files in languages with no structural adapter are counted in
`unsupportedFiles`: they cannot be checked, and the check says so rather than passing silently.

## Choosing the base

- `--base REV` compares against that revision exactly.
- `complexity.base` in `code-health.json` does the same for everyone.
- Otherwise the base is the merge base of HEAD and the main branch (`complexity.mainBranch`, or the first of `origin/main`,
  `main`, `origin/master`, `master` that exists). Commits that landed on the main branch after yours branched are not counted.

On the main branch itself the merge base is HEAD, so there is nothing to compare. For a push build, pass the commit
before the push: `--base "$BEFORE_SHA"`. For a pull request, `--base origin/$BASE_REF` then names the merge base.
The history must include the base, so use a full clone (`fetch-depth: 0`).

Uncommitted work is checked as it stands on disk, new files included, against the base. That is the pre-commit use.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Nothing new or worsened is over a threshold |
| 1 | `check` found a violation |
| 2 | Usage or config error, such as an unknown revision |
| 3 | Environment error: not a git repository, no commits, Node too old |

## GitHub Actions

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: actions/setup-node@v4
  with:
    node-version: 22.x
- name: Complexity ratchet
  run: node path/to/complexity.mjs check --base "origin/${{ github.base_ref }}"
```

## Pre-commit

```
node path/to/complexity.mjs check --base HEAD
```

compares the working tree with the last commit and fails on a new or worsened function before it is committed.

## When it fails

Simplify the function it names, following the remedy policy in the skill. Do not raise a threshold, add an `overrides`
entry or set a delta to make it pass. Those are decisions for the owner of the code, with a reason recorded in the commit.
Generated code and fixtures are the legitimate use of an override, because nobody reads them.

## Seeing the change

`diff BASE..HEAD` lists the functions the change added or changed, with before, after and delta per metric. `diff BASE`
compares with the working tree. A function that only moved is matched and left out unless its body changed.
