# The evidence pack

`structure evidence EDGE|FINDING --json` prints one pack per problem dependency. It carries facts that bear on the choice and no recommended technique.

| Field | Meaning |
|---|---|
| `kind` / `kinds` / `findings` | The problems the edge is part of, and the finding ids behind them: `cycle`, `layer-violation`, `unstable-dependency`, `incidental-coupling` or `hidden-coupling` (from the pair's quadrant, with its `coupling:` id). Null when the edge is no problem, as a real or stable pair is not. |
| `from` / `to` | The two modules (file, folder or component) and the edge direction. |
| `breakingSet` | The symbols used across the boundary that cause the problem: `symbol`, the `kind` of use, the `sites` and the files that use it (`usedBy`). Removing the whole set removes the edge. |
| `stability` | Structural stability (Martin's instability, outgoing over total dependencies) and change stability (revisions per file in the window) of each side. When they disagree, change stability is the one to use. |
| `coChange` | `shared` logical changes touching both sides out of `eligibleChanges`, each side's own count, the confidence in each direction, and the `expected` figure independence would predict. |
| `misplacement` | For each breaking-set symbol: `consumerFiles`, how many sit `onFromSide`, `onToSide` and `elsewhere`, where most are (`mostlyOn`: from, to or split) and whether `moveMayRemoveDependency`. A symbol mostly consumed on the other side is a candidate to move. |
| `unblocks` | Locality moves this dependency is blocking, with their unblocked gain, read from the locality report. Empty when there is no report for this commit. |
| `nearbyMechanisms` | At most ten census entries, those in the package of either module first (`samePackage`), then nearest first: the `mechanism`, its `variant`, where it is (`path`, `line`, the first of `count` repeats of the same entry in the same folders), what was found (`detail`), its `distance` through the folder tree (0 is inside one of the two modules) and `near`: `from`, `to` or `both`. `nearbyMechanismsOmitted` counts the census occurrences the list does not stand for. An empty list means no mechanism is in use anywhere. A short or distant list does not: run `census`. See `mechanisms.md`. |
| `quadrant` | The pair's place from `coupling`: its quadrant with the static, co-change, expected and p-value figures. |
| `layerRule` | The layer rules the edge's imports break, one entry per pair of layers, or null when none is broken or no layers are configured. |

A hidden pair has no import, so `breakingSet` is empty and `imports.fileEdges` is 0: the evidence is the `coChange` and the `quadrant`, and the question is what decision the two sides share. Name it as `coupling:<level>:<from>-><to>` or as the plain pair.

A registration hub is `hub:<file>` and its pack has a different shape, with `kind` `registration-hub`: the `features` that feed it (each with its co-change figures, how the hub names it, the `breakingSet` of symbols the hub uses from it and their `misplacement`), the four `signals` that fired, the `stability` of the module it sits in, `unblocks` and `nearbyMechanisms` around the hub and its features. It recommends nothing.

The pack is `results[0]` of the output. The top-level `evidence.grade` and the window say how much history stands behind `stability` and `coChange`. Support below the minimum is shown as such and is not a finding.
