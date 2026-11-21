# Factors

Every factor is computed deterministically and shown with its value, band, evidence and the layer that produced it. `risk explain FACTOR` prints a factor's exact definition and thresholds, and the files that drove it on the branch. This page says what each is for.

## How bands are made

A value is placed against the repository's own merged changes: the commits a merge commit brought in, taken together, or a squash commit, or a single commit on the main line. Each past change is measured as of its own time. Above the 75th percentile is `moderate`, above the 90th is `high`. The comparison is strict and a value of zero is always `low`. Count factors (a missing file, a new cycle) band on the count instead: 1 is `moderate`, 3 is `high` by default. A factor that cannot be computed is `unavailable`, never `low`.

Factors that measure nearly the same thing form a **family**, and a family counts once at its highest band. Size, spread and entropy rise together, so counting all three would count one fact three times. The families are size and diffusion, history of the touched code, completeness, and structure and content. The impact score is the sum over families, banded against the baseline's own scores.

## Impact factors

| Factor | Family | What it tells you | What to do |
|---|---|---|---|
| `size` | size and diffusion | Lines changed and files touched | Split along components that merge independently |
| `spread` | size and diffusion | How far apart the touched files are in the tree | Split along the components touched |
| `entropy` | size and diffusion | Whether the churn is concentrated or smeared | A reading aid: concentrated changes are easier to follow |
| `mixed-purpose` | size and diffusion | Moves or renames combined with content changes | Moves and renames first, on their own |
| `hotspots-touched` | history | Share of the churn landing in files that change often and recently | Review by an owner, brief the author |
| `defect-history` | history | Share of the touched files' revisions that were fixes or reverts | Treat as a prompt to read the fixes |
| `contention` | history | Other authors changing the same files lately (a count only) | Check for semantic conflicts a clean merge hides |
| `age` | history | Old files that lost their context, and files still settling | Read the file's history before reviewing |
| `abandoned-touched` | history | Touched files that are abandoned, or likely to be (needs `cochange.knowledge.enabled`; unavailable without it) | Characterisation tests and a short note before the change. Counts and file paths only, never stored |
| `missing-co-change` | completeness | Files that usually change with a touched file and are not in the change | Open each and decide. This comes first |
| `novel-coupling` | completeness | Distant files that never changed together before | Confirm the dependency is intended |
| `test-evidence` | completeness | Source changed without the tests that usually change with it, or tests deleted | Add or update the tests, or say why not |
| `blast-radius` | structure and content | Files that change with the touched ones, and fan-in when locality's report is present | Scrutinise: a flaw here is inherited widely |
| `complexity-delta` | structure and content | New hard-to-read units, or touched files that gained complexity | `complexity explain` on the named units |
| `structure-delta` | structure and content | New cycles and layer violations (needs `structure check`) | Review the new dependency |
| `sensitive-paths` | structure and content | Migrations, authentication, CI, manifests | Ask a reviewer who knows what they affect |

`complexity-delta`, `structure-delta` and `sensitive-paths` are reported and, where they are events, raise the band, but do not also count in the score. The backtest leaves the structural factors out, because each would need a parse of every past change.

## What each source gives

- **History alone** gives everything except the structural factors. It works in any language.
- **`--evidence`** takes `complexity diff --json` and `structure check --json` for this branch's base and tip. Evidence made for another base is refused.
- **Locality's report** adds fan-in to `blast-radius` when it is whole and stamped with the change's tip.
- **The blame cache** supplies placement.

## Evidence grade

Every output carries the repository's evidence grade (`strong`, `moderate`, `weak`). With `weak` evidence, present history-based findings as tentative and do not let co-change overturn what the structure says. Say what the grade is when you state the limits.
