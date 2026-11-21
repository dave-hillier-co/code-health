# Recommendations, rules and settings

Run `locality explain <rule>` for any rule below. Recommendations are deterministic: the same repository, config and entry points always give the same proposals. They are defaults. Confirm or override each one, and record every override with its reason.

## Rules by consumer count

These apply to units whose gain is at least `locality.minDistance`. Consumers are distinct production files that use the unit. Tests never pull a unit towards themselves.

| Consumers | Size | Rule | Default | Check before acting |
|---|---|---|---|---|
| 1 | tiny (at most `tinyLines`) | `single-consumer-tiny` | `inline` | Does it encode a domain rule? Is its name better than the code? |
| 1 | medium | `single-consumer-medium` | `inline` while the consumer plus the unit stay within `inlineHostLines`, otherwise `move` | Will the consumer stay readable? |
| 1 | large (over `largeLines`) | `single-consumer-large` | `move`, kept as its own module next to the consumer | Does anything else import its internals? |
| 2 | any | `two-consumers` | `move` to the target | Do the two consumers change together? If they change independently, inlining into each may be better |
| 2 | any | `independent-consumers` | `review` | The consumers' median co-change is at or below `locality.lowCoChange`: coincidental reuse. Is inlining into each better? |
| 3 or more | any | `consumers-co-change` | `keep` | The consumers' median co-change is at or above `locality.highCoChange`: the distance is earned. Still scrutinise if fan-in is high |
| 3 or more | any | `three-or-more-consumers` | `review` | Do the consumers share a reason to change? If so the distance is earned. If not, move or inline where they diverge |

A unit of several files cannot be inlined, so the inline defaults become moves.

## Rules for any unit

| Rule | Default | Meaning |
|---|---|---|
| `high-fan-in` | `scrutinise` | At least `highFanIn` consumers: the location is earned, so review the design (`scrutinise.md`) |
| `pass-through` | `inline` | Every export only forwards its arguments to another call, and there is one consumer |
| `single-consumer-barrel` | `inline` | A file that only re-exports, imported by one file: point that file at the real definitions |
| `mixed-exports` | `split` | Exports with disjoint consumers in different folders: the file is several units sharing a name |
| `blocked-by-dependency` | `blocked` | The gain is below the minimum, but would clear it if a dependency were resolved |
| `no-production-consumers` | `review` | Nothing in production uses it: dead code, or a missing entry point |
| `near-consumers` | `keep` | Already close to its consumers. Not listed |

## Guards

A guard turns an inline or a move into `review`, or `keep`:

- `within-grace-period`: the unit's entry file first appeared fewer than `locality.graceDays` days before HEAD. Re-run when it has aged.
- `creates-cycle`: moving to the target would make two folders import each other. A folder and its own subfolders are not counted.
- `other-references`: a consumer passes the unit as a value, registers it or decorates with it, so callsite counts are unreliable. Find every use before deciding.
- `package-entry`: a non-private `package.json` names the file as an entry point, so consumers outside the repository may exist.
- `interface-unit`, `overrides-inherited-method`, `recursive-unit`: the unit declares an interface or abstract class, holds a method that overrides or implements an inherited one, or holds a function that calls itself. These are not free-standing helpers, so review before inlining or moving.
- `scattered-unit`: some files of the unit live outside its entry file's folder. Handle its leaves first.
- `fixed-point`: the file matches `locality.fixedPoints` (routes, migrations, app folders). It does not move, and nothing moves into a fixed folder.

Guards the analyser cannot check, so check them yourself: framework conventions the config does not list. The grace period and the cycle guard need history and the import graph, which the analyser has, so they are rules above.

## Gain, target and blockers

- **Net distance** is the reference-weighted sum of tree distances over all the unit's boundary edges: its consumers and its own dependencies outside the unit.
- **Target** is the folder with the lowest net distance, searched along the paths between the edge endpoints. Ties go to the shallower folder, then to path order. A unit never moves for no gain.
- **Gain** is the current net distance minus the net distance at the target.
- **Blocker**: a dependency from the unit onto code that stays behind. Its `unblockedGain` is the gain if every edge to it were resolved. A `stray` is a blocker inside the unit's own neighbourhood.

## Settings

In the `locality` section of `code-health.json`:

| Setting | Default | Meaning |
|---|---|---|
| `minDistance` | 2 | Smallest net distance a move must save to be reported |
| `tinyLines` | 15 | At most this many lines is a tiny unit |
| `largeLines` | 150 | More than this many lines is a large unit |
| `inlineHostLines` | 300 | A medium unit is inlined only while its consumer stays within this |
| `highFanIn` | 8 | Consumers at or above which a unit is scrutinised |
| `maxDepth` | 6 | Deepest folder nesting a target may have |
| `fixedPoints` | `[]` | Globs of files that must not move and folders nothing may move into |

Shared across the suite: `exclude` (globs left out of the analysis), `entryPoints` (globs of production entry files, including dynamic ones the parser cannot see) and `vagueNames`.
