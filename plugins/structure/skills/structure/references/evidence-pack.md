# The evidence pack

`structure evidence EDGE|FINDING --json` prints one pack per problem dependency. It carries facts that bear on the choice and no recommended technique.

| Field | Meaning |
|---|---|
| `from` / `to` | The two modules (file, folder or component) and the edge direction. |
| `breakingSet` | The symbols used across the boundary that cause the problem: `symbol`, the `kind` of use, the `sites` and the files that use it (`usedBy`). Removing the whole set removes the edge. |
| `stability` | Structural stability (Martin's instability, outgoing over total dependencies) and change stability (revisions per file in the window) of each side. When they disagree, change stability is the one to use. |
| `coChange` | `shared` logical changes touching both sides out of `eligibleChanges`, each side's own count, the confidence in each direction, and the `expected` figure independence would predict. |
| `misplacement` | For each breaking-set symbol: `consumerFiles`, how many sit `onFromSide`, `onToSide` and `elsewhere`, where most are (`mostlyOn`: from, to or split) and whether `moveMayRemoveDependency`. A symbol mostly consumed on the other side is a candidate to move. |
| `unblocks` | Locality moves this dependency is blocking, with their unblocked gain, read from the locality report. Empty when there is no report for this commit. |
| `quadrant`, `nearbyMechanisms`, `layerRule` | Not produced yet: null or empty. Find the mechanisms near the boundary by reading the code. |

The pack is `results[0]` of the output. The top-level `evidence.grade` and the window say how much history stands behind `stability` and `coChange`. Support below the minimum is shown as such and is not a finding.
