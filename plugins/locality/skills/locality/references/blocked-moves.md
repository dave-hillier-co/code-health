# Blocked moves

Many moves are prevented by tight coupling: the unit depends on its neighbourhood as much as its consumers depend on it. `blocked` units show where breaking coupling would pay off, ranked by `unblockedGain`. List them with `analyse --recommendation blocked`.

A unit with `recommendation: move` and a non-empty `blockers` list is also a blocked unit: `summary.blockedMoves` counts them, they are part of `summary.byRecommendation.move`, and the report lists them in its blocked table. `locality move` plans them without refusing, so check `blockers` before running it.

Each entry in `blockers` has a `path`, a `kind` (`dependency`, or `stray` when it sits in the unit's own neighbourhood), the `weight` of references to it, how many other files use it (`otherConsumers`), and the `unblockedGain` if it were resolved.

Choose one outcome per blocker by judgement:

| Evidence | Likely outcome |
|---|---|
| The blocker has few other consumers, and they are near the target | **Grow the unit.** Move the blocker with it, as one commit |
| The unit and the blocker change together (read the git log of both) | **Accept the coupling.** The distance is earned. Treat the pair as one unit |
| The blocker is a file with unrelated export groups | **Split** the blocker first, then re-analyse |
| Both sides are active and change independently | **Break the dependency.** This is a design change, with its own commit and tests |
| The blocker rarely changes | **Move anyway** if the gain survives the longer edge to it. A stable dependency costs little at any distance |

Resolving a blocker lands in order: the split or the break first, as its own commit, then a re-analysis, then the move. The re-analysis is required, because resolving one blocker changes the graph and may change the target.

Each blocker carries `coChange`: `support` and `degree` between the unit and the blocker, and `blockerChanges`, how often the blocker itself changed in the window. A high `degree` is the accept-the-coupling outcome. A low `degree` with few `blockerChanges` is a stable dependency, so move anyway. A low `degree` with many `blockerChanges` is incidental coupling to break. When `coChange` is null there is no history, so use the git log of the unit and the blocker.
