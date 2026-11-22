# The change-set completeness hook

After an agent edits a file, the hook can print which files changed together with it in past commits and have not been edited in this session. It exists so the agent opens such a partner deliberately instead of finding the gap when tests fail. The confidence figure is a guideline for deciding whether to print a note, not a rule that the partner must change.

It is off by default, because injected context costs tokens. Enable it per repository in `code-health.json`:

```json
{
  "cochange": {
    "hook": { "enabled": true, "confidence": 80, "maxPartners": 3, "maxCommitsBehind": 50 }
  }
}
```

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `false` | The hook does nothing unless this is true. |
| `confidence` | 80 | Guideline, in percent of changes to the edited file that also touched the partner. A partner at or above it is named, and the note states the guideline beside each measured value. Whole number from 1 to 100. The default is a judgement call after the high-confidence couples in Tornhill's Software Design X-Rays. |
| `maxPartners` | 3 | The most partners one note names, strongest first. The note counts the qualifying partners it did not name. |
| `maxCommitsBehind` | 50 | How far the history cache may trail the analysed ref before the hook prints nothing. 0 requires an exact match. |

Partners must also reach `cochange.minSupport` shared changes.

## What it does

A `PostToolUse` hook on `Edit`, `Write` and `MultiEdit` runs the plugin's own bundle with the argument `hook`, as a fresh process with no shell (the plugin's `hooks/hooks.json` has the exact entry). It reads the edited file from the event, looks it up in the history cache, and, when partners reach the guideline, returns one note through `hookSpecificOutput.additionalContext`:

> `src/billing/invoice.ts` changed together with `src/reports/invoice-summary.ts` (confidence 82 %, 17 changes). Guideline: confidence 80 %. Not yet edited in this session, so worth a look.

It names at most `maxPartners` partners, strongest first, and adds "and N more not named" for the rest.

## Rules it keeps

- **Read-only.** It never refreshes the cache and never writes analysis results. Run any other cochange command to bring the cache up to date.
- **Prints nothing when it cannot help.** No cache, a cache further behind than `maxCommitsBehind`, a file outside the repository, an invalid config, a partner already edited or no longer on disk, or no partner at or above the guideline.
- **Once per file per session.** A second edit of the same file prints nothing.
- **Always exits 0** and never blocks an edit. It abandons its work after 200 ms and prints nothing, process start included. The `timeout` of 1 second in `hooks/hooks.json` is a backstop.
- **Session state** is its own record in `.cache/code-health/sessions/<session_id>.cochange.json`: files edited, files a note was printed for, and the last run's outcome and duration. It does not read the transcript. The cache folder ignores itself, so nothing needs adding to `.gitignore`. Delete the file to reset a session.

## When the user asks why it printed nothing

Read the last run's outcome in the session file (`lastRun.outcome`). Typical causes: the hook is not enabled, the cache is missing or too far behind (run `refresh` with the command line from SKILL.md), or no partner reaches the confidence guideline. A young repository has few such partners.
