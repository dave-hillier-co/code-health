# The post-edit complexity hook

After an agent edits a file, the hook can say that a function in it crossed a complexity threshold or got worse. It exists because this is the cheapest point to fix complexity: the code is in the agent's context and nothing has been built on it.

It is off by default, because injected context costs tokens. Enable it per repository in `code-health.json`:

```json
{
  "complexity": {
    "hook": { "enabled": true }
  }
}
```

It uses settings that already exist: `thresholds`, `delta` (how much an over-threshold function may rise before the hook speaks), `analyseTests`, `agreementBar`, `overrides` and the shared `exclude`.

## What it does

A `PostToolUse` hook on `Edit`, `Write` and `MultiEdit` runs the plugin's own bundle with the argument `hook`, as a fresh process with no shell (the plugin's `hooks/hooks.json` has the exact entry). It measures only the edited file, with the lexical layer, and compares each function with its last measurement in the session, or with the file at HEAD when the session has none. When a function crossed a threshold it was under, is new and over, or was over and rose by more than `delta`, it returns one line through `hookSpecificOutput.additionalContext`:

> src/orders.ts: `Cart.total` nesting depth rose from 2 to 5 (threshold 4). Run `node <plugin>/dist/complexity.mjs explain src/orders.ts#Cart.total` for the breakdown.

With several findings it names the worst and counts the rest.

## What it measures

The lexical layer, because loading the WASM runtime and a grammar costs about the whole time budget. Per-function lexical values are released only for a language whose agreement with the structural layer clears `agreementBar`, which every supported language does at the recorded rates. Any other file leaves the hook silent. The values and their thresholds:

| Lexical value | Over its threshold when |
|---|---|
| `nesting` | above `thresholds.nesting` |
| `keyword` (decision points, an approximation of cyclomatic complexity) | cyclomatic complexity would be above `thresholds.cyclomatic.warn`, that is `keyword + 1 > warn` |
| `bumps` | the function is a bumpy road. The sentence reads `a bumpy road` in place of a threshold. |

Cognitive complexity is not measured by the hook: it is structural. `check` and `analyse` still measure it.

A function with no name (an anonymous block the lexer cannot tell apart from one edit to the next) is left out.

## Rules it keeps

- **Read-only.** It never refreshes the cache and never writes analysis results.
- **Silent when it cannot help.** Not enabled, a file outside the repository or gone, excluded, a test file when `analyseTests` is false, binary or over 1 MB, no per-function metrics for the language, an invalid config, nothing crossed or worsened.
- **Once per file per session.** A second edit of a file it has spoken about stays quiet, however much worse. A file it was silent about is compared with its last measurement, so the next edit is judged on what that one changed.
- **Always exits 0** and never blocks an edit. It abandons its work at its time budget (150 ms, process start included) and stays silent.
- **Session state** is its own record in `.cache/code-health/sessions/<session_id>.complexity.json`: files edited, files spoken about, the last measurement of each file, and the last run's outcome and duration. It does not read the transcript. The cache folder ignores itself. Delete the file to reset a session.

## When the user asks why it is silent or noisy

Read the last run's outcome in the session file. Typical causes: the hook is not enabled, the language has no released lexical metrics, the file was already spoken about, or nothing crossed a threshold. If it speaks about code the user accepts, raise the threshold for those paths with `overrides`, a decision for the owner of the code. Do not split functions to quiet it.
