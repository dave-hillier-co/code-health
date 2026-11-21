---
name: complexity
description: Use when code is hard to understand or follow, a function is too complex, deeply nested or confusing, the user asks what to simplify or where the complexity is, wants cognitive or cyclomatic complexity measured, a bumpy road or tangled function reduced, a refactor of a complicated function planned, or a complexity check added to CI or pre-commit. Finds the functions that are hardest to understand, explains where each one's complexity comes from, and guides simplifications that make the code easier to read without scattering it into shallow helpers.
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/complexity.mjs *)
---

# Complexity

The CLI measures how hard individual functions are to understand. This skill holds the judgement: what to
simplify, how, and when to leave code alone. The CLI never edits code. You do, one simplification at a time.

Run the CLI as `node ${CLAUDE_PLUGIN_ROOT}/dist/complexity.mjs <command> --json`. Output is JSON when stdout is not a terminal,
and `--limit` (default 20) and `--fields` keep it small. Never ask for a whole repository when the top ten answer the question.

## Principles

- A metric says where to look. A red flag says what is wrong. Name the red flag for every function you act on
  (see [references/red-flags.md](references/red-flags.md)), usually *nonobvious code*, *special-general mixture*
  or *shallow module*. A finding with no red flag and no evidence that the code costs anyone anything is a candidate for
  dismissal.
- Complexity that nobody changes is cheap. Complexity in code that changes often is expensive. Rank by the second.
- The measure is a leading indicator. The outcome is that changing the code got cheaper: fewer commits to get a change
  right, fewer files read to understand it. Report the outcome, not only the score.
- Length is never a problem alone. A long, linear function is often clearer than five shallow fragments.

## Find the functions that matter

1. Ask what is hard to understand:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/dist/complexity.mjs analyse --json --limit 10
   ```

   Each row is a function with its metrics, a `score` (its highest percentile), the `dominant` metric, and `labels`
   such as `cognitive-high` or `bumpy-road`. Read `layers` and `skipped` first: a language with no structural adapter,
   and no lexical profile with measured agreement, gets file-level numbers only, and the output says so. Do not
   present a lexical value as exact. The `agreement` section carries the rate that released it.

2. The ranking is by percentile within the repository. It is **not** weighted by how often the code changes
   (`ranking.changeWeighted` is false). Before spending effort on a function, check that it is in code that moves: look at
   its history with `git log --oneline -- <path>`, or with the cochange plugin's `hotspots` if it is installed, which reads
   this plugin's `complexity.files` report. Complex code that has not changed in a year ranks last for effort.

3. For files, use `files`. A run over the whole repository on a clean tree stores the report other plugins read.

   ```
   node ${CLAUDE_PLUGIN_ROOT}/dist/complexity.mjs files --json --limit 10
   ```

4. To see only what a branch changed, use `diff main..HEAD`, or `diff main` for the working tree.

## Locate the cost

Run `explain` on the function, with its id from the `analyse` row:

```
node ${CLAUDE_PLUGIN_ROOT}/dist/complexity.mjs explain src/orders.ts#Cart.total --json
```

It lists each increment with its line, the construct, the amount and the nesting that added to it. Read it as a
budget: the lines with the largest amounts are where to work. A deeply nested `if` costs its depth. Each
sequence of `&&` or `||` costs one. `else` costs one, so does recursion, and a labelled `break` or `continue`.
`node ${CLAUDE_PLUGIN_ROOT}/dist/complexity.mjs explain cognitive` (or `cyclomatic`, `nesting`, `parameters`, `bumpy-road`) describes what a label means.

Cognitive complexity measures readability. Cyclomatic complexity measures how many paths a test suite must cover. When
they disagree, a high cyclomatic score over a low cognitive one is usually a flat `switch` or a chain of independent
guards: leave it, and cover it with tests. A high cognitive score is the one that costs a reader.

## Before changing anything

1. **Tests first.** Every simplification is a behaviour-preserving refactoring. If the function is not covered by tests,
   write characterisation tests that pin down what it does now, including its odd cases, and commit them on their own.
   A refactoring with no tests is a rewrite.
2. **Check the consumers** with a search for the function's name. A function many files call is multiplied by every
   consumer, so it is the first place to look for red flags and the last place to be careless.
3. **Look at what the codebase already does nearby.** Prefer its idioms for dispatch, errors and options. Do not introduce
   a pattern the code does not already use without asking.

## The remedy policy

Work down this list and stop at the first step that is enough. The detail and examples are in
[references/remedies.md](references/remedies.md).

1. **Simplify by deleting.** Guard clauses instead of nested `if`. Removing dead or impossible branches. Replacing a flag
   parameter with two call paths at the callers. Defining error cases out of existence. Using the standard library for
   what the code does by hand. Each of these removes decisions, so the score falls because the code is simpler.
2. **Flatten in place.** Return early. Invert a condition to remove an `else`. Merge branches that do the same thing.
   Hoist a repeated condition. Turn nested loops with a filter into a filter.
3. **Deepen rather than split.** If a function must be split, the extracted part has to be deep: a well-named unit that
   hides a decision and has a small interface. It stays in the same file and is not exported, unless evidence
   (consumers, co-change) says otherwise. Do not extract a bump, a branch or a block just because it is nested.
4. **Never game the metric.** Moving a conditional into a lookup object that encodes the same branching, splitting
   a function only to pass a threshold, or hiding `&&` chains in named booleans that are used once all count as
   regressions in review. If the branching is still there, so is the complexity.
5. **Inline what is not earning its keep.** A helper called once, that forwards its arguments, or that a reader must jump
   to in order to understand the caller, is a candidate for inlining. Removing a shallow layer deepens what remains.

Do not touch a function because it is long, or because it is just over a threshold and cheap to read. Leave it and say
why. Ousterhout's position, which the suite follows: shallow decomposition is the problem, not length.

## Commit discipline

- One simplification per commit, with tests passing before and after. A reviewer never evaluates a simplification and a
  behaviour change together, and a revert must undo exactly one step.
- The commit message states the function, the red flag you judged present, what you did and the before and after
  values from `explain` or `diff`. If you went against a recommendation or judged a signal a false positive, say which
  and why.
- End the message with the trailer that keeps suite commits out of outcome windows:

  ```
  Code-Health: complexity/<rule>
  ```

  where `<rule>` is the label you acted on (`cognitive`, `cyclomatic`, `nesting`, `parameters`, `bumpy-road`).
  The trailer goes in the last paragraph of the message, after the subject and body.
- Do not combine a simplification with a move, a rename or a formatting change.

## Check your work

After each commit, measure the change and confirm it did what you meant:

```
node ${CLAUDE_PLUGIN_ROOT}/dist/complexity.mjs diff HEAD~1..HEAD --json
```

`delta` shows the change per metric. The score of the function should fall because decisions went away. Then run the gaming
check: if the function count of the file rose (`files` shows `functions`, and `diff` shows `summary.added`) while the
total fell by only a little, you probably split instead of simplifying. Say so, and reconsider.

If a metric did not fall, do not chase it. A simplification that makes the code clearer and leaves the score is still a
good commit. A score that fell while the code got harder to follow is a bad one.

## Guard against regressions

`check` is the ratchet for CI and pre-commit. It compares the functions that changed with a base revision, and fails
(exit 1) on a new function over a threshold, or an existing one over a threshold that got worse. It never fails a
function that stays under its thresholds, and it does not need a baseline file. See
[references/ci.md](references/ci.md) for the wiring, the exit codes and the configuration.

Run `node ${CLAUDE_PLUGIN_ROOT}/dist/complexity.mjs check --json` before committing work that adds or changes functions.
If it fails, simplify the function it names: do not raise a threshold to make it pass. A raised threshold or a
per-path override in `code-health.json` is a decision for the owner of the code, with a reason recorded in the commit.

## Reporting

When you finish, report in this order and keep it short:

1. What you changed, function by function, with the red flag cited and the before and after metrics.
2. What you left alone and why.
3. What the numbers cannot tell: lexical-only languages, code outside the ranked set, and that the ranking is not yet
   weighted by change frequency.
4. The outcome to watch: whether the simplified functions are cheaper to change over the next commits. Do not claim an
   effect the data cannot show yet.

## Reference

- [references/metrics.md](references/metrics.md): how each metric is counted, the default thresholds and every config key.
- [references/remedies.md](references/remedies.md): the remedies with before and after examples, and the gaming patterns to refuse.
- [references/ci.md](references/ci.md): `check` and `diff` in CI and pre-commit, exit codes, and choosing a base.
- [references/red-flags.md](references/red-flags.md): the shared design vocabulary.
