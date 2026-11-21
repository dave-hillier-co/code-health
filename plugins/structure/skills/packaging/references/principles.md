# The principles and what each finding asks

The frame is Robert C. Martin's six package principles. Three are about cohesion, what to put inside packages, and they pull against each other. Three are about coupling, the dependencies between packages.

| Principle | In his words | What the CLI measures |
|---|---|---|
| REP, release reuse equivalency | The granule of reuse is the granule of release | Consumers, deployables, version history |
| CCP, common closure | Classes that change together are packaged together | Closure and package co-change |
| CRP, common reuse | Classes that are used together are packaged together | Reuse profile and export components |
| ADP, acyclic dependencies | The dependency graph of packages must have no cycles | Package cycles and hidden cycles |
| SDP, stable dependencies | Depend in the direction of stability | Dependencies against change stability |
| SAP, stable abstractions | Abstractness increases with stability | `A`, `I`, `D` and the zones |

REP and CCP make packages larger. CRP makes them smaller. No package satisfies all three, and the right balance moves with the project: early on ease of change (CCP) matters most, and reuse (REP, CRP) earns its weight later. So do not score a package against all three. Say which force it is serving, which it is neglecting, and what that costs.

## Closure and reuse in one paragraph

**Closure** is the share of the logical changes touching a package that touch no other package. It rises with size for no other reason than size, so it is always read beside the package's share of all changes and judged only against packages of comparable share. **Package co-change** is judged as lift over the other package's base rate of change, because a package that changes in most commits has high confidence towards it whatever the relation. **Reuse profile** is, for each consumer, the share of the package's exported surface it uses. **Export components** are exports linked when they share consumers or refer to each other.

## Findings

Every finding raises a question for review and never proves a fault. `changeCost` is the number of logical changes in the window that crossed the boundary in question, weighted by recency.

### Common closure

| Finding | Question it raises | The cheaper fix to try first |
|---|---|---|
| `low-closure` | Changes here usually need another package too: the boundary is in the wrong place, or there are too many | Look at `crossing-unit` findings: one file may be on the wrong side |
| `always-together` | One unit of change split in two | Merge, after the disjoint-reuse check the CLI already did |
| `follower` | Changing A means changing B's interface: B's interface is not hiding what it should | Move the part of B that A drives into A |
| `crossing-unit` | A file whose co-change partners are mostly in another package | Move the file |
| `wide-change` | The packages cut across the features | A trend: ask whether the packages are layers by kind |

### Common reuse

| Finding | Question it raises | The cheaper fix to try first |
|---|---|---|
| `partial-use` | Consumers depend on things they do not use | Narrow the interface |
| `disjoint-reuse` | Several packages sharing a name | Split along the components, after the always-together check |
| `dumping-ground` | Coincidental cohesion: every change risks everything | Split by component; stop adding to it |
| `inherited-weight` | A dependency paid for by code that does not use it | Move the heavy part out |
| `overexposed` | The interface is wider than its consumers need | Narrow it |

### Reuse and release

| Finding | Question it raises | Note |
|---|---|---|
| `single-consumer` | Nothing is being reused | Merge into the consumer, unless the declared purpose still holds |
| `no-consumer` | Dead, or an entry point missing from config | Ask before deleting |
| `lockstep` | Released as one unit already: separate versions are ceremony | Not raised where tooling fixes versions |
| `one-deployable` | No release life of its own | Needs deployables from config |
| `pass-through-package` | A shallow module at package level | Remove it |
| `tiny` | Costs more to have than it contains | Merge |

### Acyclic, stable, abstract

| Finding | Question it raises | Note |
|---|---|---|
| `package-cycle` | Neither can be built, tested or released without the other | Hand to the structure skill with `structure evidence A->B --level package` |
| `hidden-cycle` | The build forbids the cycle, so it went where the build cannot see | Through test code alone it is low priority |
| `against-stability` | The stable package is made to change with the volatile one | Change evidence outranks structure |
| `zone-of-pain` | Concrete, widely depended on, still changing | A stable concrete package that rarely changes is healthy |
| `zone-of-uselessness` | Abstractions with no consumers | |
| `volatile-interface` | The interface does not shield consumers from change | Reads changes to the files defining the exports, so it over-reads |

### Boundaries

| Finding | Question it raises |
|---|---|
| `deep-import` | The boundary is not real: the declared interface is not the one in use |
| `undeclared-dependency` | The graph the build sees is not the real one |
| `unused-dependency` | Declared coupling with no purpose, and build weight |
| `purpose-mismatch` | The reason the package exists is not being served |

## The balance

`cohesion` reports for each package where it sits between closure, reuse and release, and which force its situation makes matter most (`matters`). Read `reading`, then the findings in `neglected`. A package that changes often and has one or two consumers: closure matters, and merging is the default candidate. One that rarely changes and has many consumers has earned its boundary: reuse matters, and the question is whether consumers carry parts they do not need.
