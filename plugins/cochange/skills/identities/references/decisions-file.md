# The decisions JSON for `identities apply`

Write it outside the repository (a temporary path), and pass it with `--from`. Names and emails must be exactly as `identities list` shows them.

```json
{
  "merges": [
    {
      "canonical": { "name": "Jo Park", "email": "jo+git@x.com" },
      "aliases": [{ "name": "J Park", "email": "Jo@X.com" }]
    }
  ],
  "rejectedMerges": [
    { "identities": ["Alex Kim <alex@a.com>", "Alex Kim <akim@b.com>"], "reason": "two people, one name" }
  ],
  "classifications": [
    { "identity": "Jenkins <jenkins@corp.com>", "kind": "service" },
    { "identity": "Release <release@corp.com>", "kind": "person", "reason": "a human named Release" }
  ]
}
```

- `merges`: each alias is shown as the canonical identity. Use the proposal's `suggestedCanonical` (the most recently active member) unless the user prefers another. Each alias becomes one full-form `.mailmap` line, `Canonical Name <canonical@email> Alias Name <alias@email>`.
- `rejectedMerges`: pairs that are different people. Stored in the decisions file, never in `.mailmap`, and never proposed again.
- `classifications`: `kind` is `bot`, `service`, `agent` or `person`. `person` overrides a pattern that misfired. They are matched by email address.

`apply` refuses a name or email that is not in the history, a merge of a pair recorded as different people, and an alias the mailmap already maps to someone else. It never removes a line.

## Files

| Location | Mailmap | Decisions |
|---|---|---|
| committed | `.mailmap` | `.code-health/identity-decisions.json` |
| local | `.code-health/local/mailmap` | `.code-health/local/identity-decisions.json` |

The local folder carries its own `.gitignore` with `*`.
