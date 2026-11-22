# The post-edit complexity hook

After an agent edits a file, the hook can print one line saying that a function in it went above a complexity guideline or got worse. It exists because this is the cheapest point to fix complexity: the code is in the agent's context and nothing has been built on it.

It is off by default, because injected context costs tokens. Enable it per repository in `code-health.json`:

```json
{
  "complexity": {
    "hook": { "enabled": true }
  }
}
```

It uses settings that already exist: `guidelines` (the per-metric guidelines, which are not rules), `delta` (how much a function above a guideline may rise before the hook prints), `analyseTests`, `agreementBar`, `overrides` and the shared `exclude`.

## What it does

A `PostToolUse` hook on `Edit`, `Write` and `MultiEdit` runs the plugin's own bundle with the argument `hook`, as a fresh process with no shell (the plugin's `hooks/hooks.json` has the exact entry). It measures only the edited file, with the lexical layer, and compares each function with its last measurement in the session, or with the file at HEAD when the session has none. When a function went above a guideline it was under, is new and above one, or was above and rose by more than `delta`, it returns one line through `hookSpecificOutput.additionalContext`:

> src/orders.ts: `Cart.total` nesting depth rose from 2 to 5 (guideline 4, ratio 1.25). Worth a look: run `node <plugin>/dist/complexity.mjs explain src/orders.ts#Cart.total` for the breakdown.

With several findings it names the one furthest above its guideline and counts the rest. A unit that is new in the file may be an old unit that was renamed: the hook compares names and has no bodies to match, so the line says `a new or renamed unit`. The hook uses the lexical layer only, within a budget of 150 ms including process start, so its values are less exact than `check`'s.

## What it measures

The lexical layer, because loading the WASM runtime and a grammar costs about the whole time budget. Per-function lexical values are released only for a language whose agreement with the structural layer clears `agreementBar`, which every supported language does at the recorded rates. For any other file the hook prints nothing and records the reason in the session file. The values and their guidelines:

| Lexical value | Above its guideline when |
|---|---|
| `nesting` | above `guidelines.nesting` |
| `keyword` (decision points, an approximation of cyclomatic complexity) | cyclomatic complexity would be above `guidelines.cyclomatic.warn`, that is `keyword + 1 > warn` |
| `bumps` | the function is a bumpy road. The sentence reads `above guideline: a bumpy road` in place of a guideline value. |

Cognitive complexity is not measured by the hook: it is structural. `check` and `analyse` still measure it.

A function with no name (an anonymous block the lexer cannot tell apart from one edit to the next) is left out.

## Rules it keeps

- **Read-only.** It never refreshes the cache and never writes analysis results.
- **Prints nothing when it cannot help.** Not enabled, a file outside the repository or gone, excluded, a test file when `analyseTests` is false, binary or over 1 MB, no per-function metrics for the language, an invalid config, nothing went above a guideline or worsened.
- **Once per file per session.** A second edit of a file it has already printed for prints nothing, however much worse. A file it printed nothing for is compared with its last measurement, so the next edit is judged on what that one changed.
- **Always exits 0** and never blocks an edit. It abandons its work at its time budget (150 ms, process start included) and prints nothing.
- **Session state** is its own record in `.cache/code-health/sessions/<session_id>.complexity.json`: files edited, files printed for, the last measurement of each file, and the last run's outcome and duration. It does not read the transcript. The cache folder ignores itself. Delete the file to reset a session.

## When the user asks why it printed nothing, or printed too much

Read the last run's outcome in the session file. Typical causes: the hook is not enabled, the language has no released lexical metrics, the file was already printed for, or nothing went above a guideline. If it prints for code the user accepts, change the guideline for those paths with `overrides`, a decision for the owner of the code. Do not split functions to stop it printing.
