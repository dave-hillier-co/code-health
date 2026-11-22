import type { Rule } from "@code-health/cli-kit/run-cli";

const rule = (summary: string, ...lines: string[]): Rule => ({ summary, explanation: lines.join("\n") });

const caveat =
  "A finding raises a question for review and never proves a fault. Findings about a package inside the grace period (structure.packages.graceDays) are tentative. A finding whose measured value is below its guideline is still listed, after the others, with aboveGuideline false; it feeds no candidate and no balance.";

/** What `structure explain <finding>` says about each finding of `structure packages`. */
export const rules: Record<string, Rule> = {
  "low-closure": rule(
    "Changes to this package usually need another package too",
    "Closure is the share of the changes touching a package that touch no other package (the common closure principle). It rises with size for no other reason than size, so a package is only judged against packages whose share of all changes is within structure.packages.closureBand of its own, and only when at least minComparable of them exist. It is raised when its closure is in the lowest quartile of that group.",
    caveat,
  ),
  "always-together": rule(
    "Two packages are one unit of change split in two",
    "Both packages' changes are mostly shared changes: the confidence in each direction reaches structure.packages.minConfidence, the lift over the other's base rate of change reaches minLift, the shared changes reach minSupport, and an exact test finds them unlikely under independence at the significance level. Lift matters because a package that changes in most commits has high confidence towards it whatever the relation. A candidate to merge.",
    caveat,
  ),
  follower: rule(
    "Changing the dependant usually changes what it depends on, and not the other way round",
    "A depends on B, the confidence A to B reaches minConfidence and B to A stays at or below followerReverseConfidence, with the same lift and significance tests as always-together. B's interface is not hiding what it should, or part of B belongs in A (information leakage). A candidate to move a unit.",
    caveat,
  ),
  "crossing-unit": rule(
    "A file whose co-change partners lie mostly in another package",
    "More than crossingUnitShare of the files that change with it are in one other package, more than in its own, and it is that much more entangled with the other package (crossingUnitMargin) than its own package is overall. A unit on the wrong side of the boundary: a candidate to move across.",
    caveat,
  ),
  "wide-change": rule(
    "The packages cut across the features",
    "At least wideChangeShare of the logical changes touch wideChangePackages packages or more. Reported as a repository trend with the earlier and later half of the window. Layering by kind (ui, domain, data) at package level.",
    caveat,
  ),
  "partial-use": rule(
    "Consumers are made to depend on things they do not use",
    "Most consumers use under partialUseShare of the exported surface, which is what the entry files in the manifest export, followed through re-exports to the definitions. Needs at least partialUseMinSurface exports.",
    caveat,
  ),
  "disjoint-reuse": rule(
    "Several packages sharing a name",
    "Export components are exports linked when they share consumers or one refers to another. Two or more components with consumers whose consumer sets overlap by at most disjointOverlap are reused separately. A candidate to split along the components.",
    caveat,
  ),
  "dumping-ground": rule(
    "Coincidental cohesion at package level",
    "Fan-in of at least dumpingMinConsumers, at least dumpingMinComponents export components with consumers, more revisions than the median package, and at least dumpingMinContributors people changing it (unless its name is one of dumpingNames). Every change to it risks everything and most consumers needed none of it.",
    caveat,
  ),
  "inherited-weight": rule(
    "A dependency paid for by code that does not use it",
    "A consumer uses only part of a package, and the outside packages the package imports, less those the used part reaches through the package's own imports, number at least inheritedWeightPackages and at least half of all it imports.",
    caveat,
  ),
  overexposed: rule(
    "The interface is wider than its consumers need",
    "At least overexposedShare of the exports are used by no other package. A package that re-exports a name counts as using it. A candidate to narrow the interface.",
    caveat,
  ),
  "single-consumer": rule(
    "Nothing is being reused",
    "An internal package that exactly one package uses, past the grace period. Test support packages and entry points are excluded. A declared dependency that nothing imports is not a use. Unless its declared purpose says otherwise, a candidate to merge into its consumer.",
    caveat,
  ),
  "no-consumer": rule(
    "Dead, or an entry point missing from config",
    "Nothing uses it, and it is not an entry point, test support, or declared for deploy. A published package is reported at low priority, because its consumers outside the repository cannot be seen.",
    caveat,
  ),
  lockstep: rule(
    "They are released as one unit already",
    "Two packages whose versions changed in exactly the same commits in the window, at least minSupport of them, where nothing fixes it: one version for every published package, or no real versions, makes this a policy and it is not raised.",
    caveat,
  ),
  "one-deployable": rule(
    "It has no release life of its own",
    "In a repository with more than one deployable, a package that ships in only one. A deployable is an entry point, or a name in structure.packages.byPackage.<package>.deployables.",
    caveat,
  ),
  "pass-through-package": rule(
    "A shallow module at package level",
    "At least passThroughShare of what the package exports is defined in another package and only passed along. A candidate to remove.",
    caveat,
  ),
  tiny: rule(
    "The package costs more to have than it contains",
    "Among the smallest packages by file count (structure.packages.tinyPercentile), and holding no more than its manifest, its entry point and one other file.",
    caveat,
  ),
  "package-cycle": rule(
    "Neither package can be built, tested or released without the other",
    "A strongly connected component of the package graph, which has an edge for every manifest dependency and every import between packages, with the smallest set of dependencies whose removal breaks it. Handed to the structure skill with its evidence pack.",
    caveat,
  ),
  "hidden-cycle": rule(
    "The build forbids the cycle, so it has gone where the build cannot see",
    "No cycle in the production dependencies, but one once development dependencies and imports from test code are added. A cycle through test code alone is reported at low priority.",
    caveat,
  ),
  "against-stability": rule(
    "The stable package is made to change with the volatile one",
    "A dependency from a package onto one that changes more often per file than it does, by structure's own rule: change evidence decides whenever the depended-on package is active.",
    caveat,
  ),
  "zone-of-pain": rule(
    "Concrete, widely depended on and still changing: every change ripples",
    "A + I is at most 1 - zoneDistance (low abstractness and low instability), at least two packages depend on it, and it has more revisions than the median package. A stable concrete package that rarely changes is healthy and is not raised. Where A is weak (few exported types) the finding says so and the change evidence carries it.",
    caveat,
  ),
  "zone-of-uselessness": rule(
    "Interfaces written for consumers that never arrived",
    "A + I is at least 1 + zoneDistance (abstract, and unstable because nothing depends on it), it exports at least one type, and at most one package depends on it.",
    caveat,
  ),
  "volatile-interface": rule(
    "The interface is not shielding consumers from change",
    "The files that define what the package exports changed in at least volatileInterfaceShare of its revisions. A change inside an exported function counts too, so this over-reads.",
    caveat,
  ),
  "deep-import": rule(
    "The boundary is not real",
    "A consumer imports a file that is not one of the package's entry files: those the manifest names in exports, main or module. A package with a wildcard in exports exposes every file it matches and has none. The package's own tests are not consumers.",
    caveat,
  ),
  "undeclared-dependency": rule(
    "The dependency graph the build sees is not the real one",
    "A package's code imports another package, in this repository or outside it, that its manifest does not declare as a dependency (production code needs a runtime dependency, tests any). When only the workspace root declares it, the finding says so.",
    caveat,
  ),
  "unused-dependency": rule(
    "Declared coupling with no purpose, and build weight",
    "A runtime dependency in the manifest that no file of the package imports. Peer and optional dependencies, development dependencies and @types packages are not checked, since tools use them without importing them.",
    caveat,
  ),
  "purpose-mismatch": rule(
    "The reason the package exists is not being served",
    "The evidence contradicts the declared purpose: reuse with one consumer or none, enforcement with consumers that import its internals.",
    caveat,
  ),
};
