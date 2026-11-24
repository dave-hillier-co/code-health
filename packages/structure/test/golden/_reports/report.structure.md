# Structure report

- Repository: repo
- Analysed commit: `15d0025597eb9e7c8a2acaf7fcdbbce7858dc064`
- Date: 2024-05-25
- Config hash: `0000000000000000`
- Evidence grade: weak
- History window: 3.7 months of usable history; the analysis window is 12 months, 2023-05-25 to 2024-05-25
- Excluded:
  - commits of imported history: 1

## What to look at first

**The structure at a glance**

| Measure | Value |
| --- | --- |
| Import cycles at the default level | 2 |
| Layer violations | 1 |
| Dependencies pointing towards less stable folders | 1, of which 1 reach a guideline |
| Registration hubs | 0 |
| Packages | 5 |

**Module dependency matrix** (file imports from the row module into the column module; band 1: 1)

|  | …kages/p1/src/use.ts | packages/p1/src/x.ts | …ges/p4/src/ports.ts | src/c.ts | src/d.ts | src/e.ts | src/leaf.ts | src/ui/view.ts | packages/p2/src/y.ts | …ges/p3/src/types.ts | …ges/p5/src/model.ts | src/b.ts | src/a.ts | src/core/model.ts | packages/p1/src/z.ts | src/ui/format.ts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| …kages/p1/src/use.ts | none | none | none | none | none | none | none | none | none | 1 | 1 | none | none | none | none | none |
| packages/p1/src/x.ts | none | none | none | none | none | none | none | none | 1 | none | none | none | none | none | none | none |
| …ges/p4/src/ports.ts | none | none | none | none | none | none | none | none | none | 1 | none | none | none | none | none | none |
| src/c.ts (cycle 1) | none | none | none | none | 1 | none | none | none | none | none | none | none | none | none | none | none |
| src/d.ts (cycle 1) | none | none | none | none | none | 1 | none | none | none | none | none | none | none | none | none | none |
| src/e.ts (cycle 1) | none | none | none | 1 ! | none | none | none | none | none | none | none | none | none | none | none | none |
| src/leaf.ts | none | none | none | none | none | none | none | none | none | none | none | none | 1 | none | none | none |
| src/ui/view.ts | none | none | none | none | none | none | none | none | none | none | none | none | none | 1 | none | none |
| packages/p2/src/y.ts | none | none | none | none | none | none | none | none | none | none | none | none | none | none | 1 | none |
| …ges/p3/src/types.ts | none | none | none | none | none | none | none | none | none | none | none | none | none | none | none | none |
| …ges/p5/src/model.ts | none | none | none | none | none | none | none | none | none | none | none | none | none | none | none | none |
| src/b.ts (cycle 2) | none | none | none | none | none | none | none | none | none | none | none | none | 1 | none | none | none |
| src/a.ts (cycle 2) | none | none | none | none | none | none | none | none | none | none | none | 1 ! | none | none | none | none |
| src/core/model.ts | none | none | none | none | none | none | none | none | none | none | none | none | none | none | none | 1 L |
| packages/p1/src/z.ts | none | none | none | none | none | none | none | none | none | none | none | none | none | none | none | none |
| src/ui/format.ts | none | none | none | none | none | none | none | none | none | none | none | none | none | none | none | none |

! is a dependency against the order: below the diagonal, inside an import cycle (2 cells); L is an import the configured layer rules forbid (1 cell). Boxes along the diagonal mark 2 groups: cycle 1 (3 rows), cycle 2 (2 rows). A row is a module and the cells in it are the modules it depends on. Rows are ordered by layer, top first: a module comes after every module that depends on it, so in a layered design every cell is above the diagonal. The members of one cycle stay together in a box labelled as in the cycles table, ordered so that only the edges of its breaking set lie below the diagonal. Names are cut from the left to 20 characters; the cycles table gives them whole.

The matrix draws all 16 modules of typescript, the language with the most modules at the default level.

**Judgement: what to look at first**

The cycles are small and the history is short, so little can be said with confidence.

## Import cycles

Cycles are found at the default level: a Go package for Go, a project for C# and a file for every other language. The breaking set is the smallest set of edges whose removal makes the cycle acyclic, and between equally small sets the one whose sides co-change least. Nested folder cycles, a folder and its own sub-folder, sort last.

**Import cycles, largest first**

| # | Modules in the cycle | Size | Breaking set found by | Edges to break | Changes touching two members | Nested folders |
| ---: | --- | ---: | --- | ---: | ---: | --- |
| 1 | src/c.ts, src/d.ts, src/e.ts | 3 | exact | 1 | 5 | no |
| 2 | src/a.ts, src/b.ts | 2 | exact | 1 | 0 | no |

**Cycle 1: the breaking set of 1 edge (exact)**

| Edge to break | Changes touching both sides | File imports | Type only | Symbols used across it |
| --- | ---: | ---: | --- | --- |
| src/e.ts → src/c.ts | 0 | 1 | no | src/c.ts#gamma (1 site) |

**Judgement: cycle 1 (src/c.ts, src/d.ts and 1 more)**

Verdict: break-the-listed-edge. The edge carries one call, so it is cheap to move.

**Cycle 2: the breaking set of 1 edge (exact)**

| Edge to break | Changes touching both sides | File imports | Type only | Symbols used across it |
| --- | ---: | ---: | --- | --- |
| src/a.ts → src/b.ts | 0 | 1 | no | src/b.ts#beta (1 site) |

**Judgement: cycle 2 (src/a.ts, src/b.ts)**

Verdict: break-the-listed-edge. The edge carries one call, so it is cheap to move.

## Layer violations

Layers are declared in order, top first, in structure.layers: ui, core. Each row is one file import that crosses to a layer its rule does not allow. Value imports come first, then type-only imports.

**Imports that break the layer rules**

| # | Importing file | Imported file | Layers | Type only | Symbols used |
| ---: | --- | --- | --- | --- | --- |
| 1 | src/core/model.ts | src/ui/format.ts | core → ui | no | src/ui/format.ts#format |

## Stability

**Packages by instability and abstractness** (instability I against abstractness A)

| # | Package | Instability I | Abstractness A | Distance | Ca | Ce | Exported types | Position |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | packages/p4 | 1 | 1 | 1 | 0 | 1 | 3 | zone of uselessness |
| 2 | packages/p5 | 0 | 0 | 1 | 1 | 0 | 3 | zone of pain |
| 3 | packages/p3 | 0 | 0.67 | 0.33 | 2 | 0 | 3 | outside the zones |

_The dashed diagonal is the main sequence, where A + I = 1. A zone starts 0.5 from it (structure.packages.zoneDistance, a judgement call): the zone of pain is concrete and stable (A + I at most 0.5) and the zone of uselessness is abstract and unstable (A + I at least 1.5). Square points are inside a zone, round points are not, and the table gives each position in words. A guideline orders and labels results; it decides nothing._

_Of the 3 measured packages, 1 are in the zone of pain, 1 in the zone of uselessness and 1 outside the zones._

_The table lists 3 of 3 packages, furthest from the main sequence first; 0 not listed._

> **Notice:** 2 packages have too few exported types to place (fewer than 3, structure.packages.minExportedTypes, a judgement call); abstractness is not measured for them. They are left out of the chart, its table and its zone counts.

A dependency should point towards the more stable side. Structural stability is Martin's instability I = Ce / (Ca + Ce) over distinct outside files. Change stability is revisions per file in the window, and it decides when the depended-on side has at least structure.minRevisions revisions. The table is sorted by, in order: rows at or above a guideline first; rows decided by change before rows decided by structure; the larger margin, which for change is the depended-on side's revisions per file minus the dependant's (both shown) and for structure is the instability gap; file imports; path. A row decided by change can have a negative instability gap: it is listed because the depended-on folder has more revisions per file, even when it is structurally more stable. No row is hidden for being below a guideline.

**Dependencies pointing towards less stable folders**

| # | From (depends) | To (depended on) | Decided by | Revisions per file, from | Revisions per file, to | Revisions per file, to over from | Instability gap in points | File imports | Measures disagree |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | packages/p2/src | packages/p1/src | structure | 0 | 0.33 | – | 25 ▲ | 1 | no |

_Guidelines order and label the rows and decide nothing. Revisions per file, to over from 2 (structure.minVolatilityRatio), ▲ marks a value above it; Instability gap in points 20 (structure.minInstabilityGap), ▲ marks a value above it._

**Judgement: dependency 1 (packages/p2/src → packages/p1/src)**

Verdict: worth-fixing. The edge carries one call, so it is cheap to move.

## Decoupling mechanisms in use

**Decoupling mechanisms the codebase uses today**

| Mechanism | Occurrences | Files | Variants | Busiest folders (counts include the folders of implementers and callers) | Example |
| --- | ---: | ---: | --- | --- | --- |
| callbacks | 0 | 0 | – | – | – |
| interfaces | 0 | 0 | – | – | – |
| dependency-injection | 0 | 0 | – | – | – |
| events | 0 | 0 | – | – | – |
| handlers | 0 | 0 | – | – | – |
| registries | 0 | 0 | – | – | – |
| ports-and-adapters | 0 | 0 | – | – | – |

> **Notice:** The census describes and does not judge. A count of zero is a finding: callbacks, interfaces, dependency-injection, events, handlers, registries, ports-and-adapters are not in use here, so choosing one would introduce something new.

**Hubs:** No file is listed as a hub: each of the 2 files with at least 3 changes reached fewer than 2 of the 4 signals (2 of them without reading their diffs, because the other three signals left them unable to reach 2). 8 more files have fewer than 3 changes.

## Limits

- Guidelines order and label results. They are heuristics for investigation and decide nothing.
- Each list shows its top rows and says how many it leaves out: 5 cycles, 8 dependencies against stability, 15 layer violations, 10 hubs and 15 packages in the stability table (the chart draws every package that exports types). The commands print the rest.
- Cycles are found at the default level for each language, so a file cycle in Go or C# that stays inside one package or folder is not shown. `structure cycles --level` shows the other levels.
- Abstractness is measured for packages from the exported interfaces, abstract classes, classes and enums. A package that exports fewer than 3 types (structure.packages.minExportedTypes) has too few for the abstract-to-concrete ratio to mean anything, so it is unplaced: left out of the chart, its table and its zone counts, and counted. Folders have no abstractness, so the chart is of packages and the dependencies against stability are between folders.
- The zones of the chart are geometric. `structure packages coupling` raises a finding only when a package in a zone also has dependents and changes often.
- The census finds mechanisms by name and shape, so a look-alike can be counted and a custom convention missed.
- The evidence grade is weak, so change stability and the co-change counts are tentative and the static structure should lead.

**Judgement: what limits these results**

The cycles are small and the history is short, so little can be said with confidence.
