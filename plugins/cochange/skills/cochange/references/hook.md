# The change-set completeness hook

After an agent edits a file, the hook can say which files usually change with it and have not been edited in this session. It exists so the agent opens a usual partner deliberately instead of finding the gap when tests fail.

It is off by default, because injected context costs tokens. Enable it per repository in `code-health.json`:

```json
{
  "cochange": {
    "hook": { "enabled": true, "confidence": 80, "maxCommitsBehind": 50 }
  }
}
```

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `false` | The hook does nothing unless this is true. |
| `confidence` | 80 | Percent of changes to the edited file that also touched the partner. Whole number from 1 to 100. |
| `maxCommitsBehind` | 50 | How far the history cache may trail the analysed ref before the hook goes silent. 0 requires an exact match. |

Partners must also reach `cochange.minSupport` shared changes.

## What it does

A `PostToolUse` hook on `Edit`, `Write` and `MultiEdit` runs the plugin's own bundle with the argument `hook`, as a fresh process with no shell (the plugin's `hooks/hooks.json` has the exact entry). It reads the edited file from the event, looks it up in the history cache, and, when partners clear the thresholds, returns one note through `hookSpecificOutput.additionalContext`:

> `src/billing/invoice.ts` usually changes with `src/reports/invoice-summary.ts` (confidence 82 %, 17 changes). Not yet edited in this session.

It names at most three partners, strongest first.

## Rules it keeps

- **Read-only.** It never refreshes the cache and never writes analysis results. Run any other cochange command to bring the cache up to date.
- **Silent when it cannot help.** No cache, a cache further behind than `maxCommitsBehind`, a file outside the repository, an invalid config, a partner already edited or no longer on disk, or no partner above the threshold.
- **Once per file per session.** A second edit of the same file stays quiet.
- **Always exits 0** and never blocks an edit. It abandons its work after 500 ms and stays silent, process start included.
- **Session state** is its own record in `.cache/code-health/sessions/<session_id>.json`: files edited, files spoken about, and the last run's outcome and duration. It does not read the transcript. The cache folder ignores itself, so nothing needs adding to `.gitignore`. Delete the file to reset a session.

## When the user asks why it is silent

Read the last run's outcome in the session file. Typical causes: the hook is not enabled, the cache is missing or too far behind (run `refresh` with the command line from SKILL.md), or no partner reaches the confidence threshold. A young repository has few such partners.
