import type { Family, Layer } from "./measure.ts";

export interface FactorDoc {
  name: string;
  family: Family;
  layer: Layer;
  /** How the value is banded: against the repository's merged changes, or on a count. */
  banding: "percentile" | "count" | "none";
  /** What it measures. */
  signal: string;
  /** Exactly how this tool computes it, so the number can be checked by hand. */
  definition: string;
  /** Why it matters. */
  why: string;
}

/** Every factor of the skill, in the order the output lists them. */
export const FACTOR_DOCS: readonly FactorDoc[] = [
  {
    name: "size",
    family: "size-and-diffusion",
    layer: "history",
    banding: "percentile",
    signal: "Lines added plus deleted, and files touched",
    definition: "The sum of added and deleted lines over the files left after the noise filters (binary files add nothing). Banded on the lines. The file count is shown beside it.",
    why: "Larger changes hide more, and review attention per line falls as size grows.",
  },
  {
    name: "spread",
    family: "size-and-diffusion",
    layer: "history",
    banding: "percentile",
    signal: "Change spread of the touched files, with folders and components touched",
    definition: "The mean tree distance over every pair of touched files, the suite's one tree distance function. Zero for a change of one file. The distinct folders, and the components when configured, are shown beside it.",
    why: "A scattered change needs knowledge of several areas at once.",
  },
  {
    name: "entropy",
    family: "size-and-diffusion",
    layer: "history",
    banding: "percentile",
    signal: "How evenly the churn is distributed over the touched files",
    definition: "Shannon entropy in bits, H = -sum(p log2 p), where p is each file's share of the change's churn (Hassan's change entropy as Kamei et al. use it). Zero for a change concentrated in one file.",
    why: "A change concentrated in one file is easier to follow than the same churn smeared over twenty.",
  },
  {
    name: "mixed-purpose",
    family: "size-and-diffusion",
    layer: "history",
    banding: "count",
    signal: "Renames or moves combined with content changes",
    definition: "The number of moved files, when the change also edits content (another file, or the moved file itself). Zero otherwise. Pure moves are filtered out of past history, so the baseline cannot see them, which is why the factor is banded on a count and not against the baseline. The backtest sees only moves that also edit the file.",
    why: "The change is probably several changes, and a reviewer cannot evaluate a move and a behaviour change together.",
  },
  {
    name: "hotspots-touched",
    family: "history",
    layer: "history",
    banding: "percentile",
    signal: "Share of the change's churn landing in hot files",
    definition: "A file is hot when it was changed within the recent window and its revisions in the analysis window put it in the top (100 - cochange.hotspotPercentile) percent of changed files, as of the base. Complexity is left out of the ranking, because it cannot be measured for every past commit. The factor is the share of the change's churn that lands in hot files.",
    why: "Hotspots are where complexity and change meet, and where defects concentrate.",
  },
  {
    name: "defect-history",
    family: "history",
    layer: "history",
    banding: "percentile",
    signal: "Share of each touched file's revisions that were fixes",
    definition: "Over the touched files' revisions in the analysis window, the share made by a change whose subject matches history.fixPatterns (cochange.fixPatterns when set). A revert is not a fix. Each file lists the commits that matched and the pattern that matched, and the patterns also match subjects that are not defects, such as \"fix the bug report template\", while a fix of typos, lint, docs or tests is left out by history.fixExcludePatterns. Unavailable when no change in the window matches, since the repository then has no convention to read.",
    why: "Code that has needed fixing tends to need it again.",
  },
  {
    name: "contention",
    family: "history",
    layer: "history",
    banding: "percentile",
    signal: "Distinct authors who changed the touched files in the recent window",
    definition: "The number of distinct authors, other than the change's own, who changed any touched file within cochange.recentMonths of the change. A count only: no name appears in the evidence.",
    why: "Concurrent work raises the chance of semantic conflicts that a clean merge does not show.",
  },
  {
    name: "age",
    family: "history",
    layer: "history",
    banding: "percentile",
    signal: "Touched files not changed within the stale window, and files changed within the last few days",
    definition: "Two shares of the touched files that already existed: those last changed more than cochange.staleMonths before the change, and those last changed within cochange.risk.settlingDays. Each side is banded on its own and the factor takes the higher.",
    why: "Old code has lost its context. Very recent code is still settling.",
  },
  {
    name: "abandoned-touched",
    family: "history",
    layer: "history",
    banding: "count",
    signal: "Touched files already abandoned, or with high abandonment probability",
    definition: "Needs the knowledge analysis (cochange.knowledge.enabled), and is unavailable without it. Counts the touched files that existed at the base and are abandoned there (at least cochange.knowledge.abandonmentGuideline percent of the lines held by people belong to people who have left, judged at the tip's date), or whose simulated probability of becoming abandoned within the horizon reaches cochange.knowledge.atRiskProbability percent. Banded on the count. Computed from the blame cache and never stored, and the evidence names files, not people.",
    why: "Nobody is left who can review these with first-hand knowledge.",
  },
  {
    name: "missing-co-change",
    family: "completeness",
    layer: "history",
    banding: "count",
    signal: "Files that usually change with a touched file and are missing from the change",
    definition: "Files whose confidence towards a touched file is at least cochange.risk.missingConfidence percent, with support of at least cochange.minSupport, over the eligible changes of the analysis window, that exist and are not touched by the change. Confidence is shared changes divided by the touched file's changes. Banded on the count.",
    why: "The strongest single completeness signal: these files have needed changing every other time.",
  },
  {
    name: "novel-coupling",
    family: "completeness",
    layer: "history",
    banding: "count",
    signal: "Pairs of touched files at high tree distance that have never changed together",
    definition: "Pairs of touched, existing files with history, at tree distance of at least cochange.risk.novelDistance, that were never in one eligible change before. Banded on the count of pairs.",
    why: "The change may be introducing a dependency between areas that were independent.",
  },
  {
    name: "test-evidence",
    family: "completeness",
    layer: "history",
    banding: "count",
    signal: "Source files changed without the tests that usually change with them, and test deletions",
    definition: "Touched source files whose sibling test exists, is untouched by the change, and changed with the file in at least cochange.risk.testShare percent of its revisions (with support of at least cochange.minSupport), plus deleted test files. Banded on the count.",
    why: "Behaviour may have changed without tests following.",
  },
  {
    name: "blast-radius",
    family: "structure-and-content",
    layer: "history",
    banding: "percentile",
    signal: "Files with high co-change confidence towards the touched files",
    definition: "Without a locality report, the number of files with confidence and support at or above the missing-co-change guidelines towards any touched file. With locality's report for this commit, the fan-in of the touched files. When a parse adapter reads any touched file, also the exported symbols of the touched files whose signature changed (kind or interface size) or that were removed, each with the number of files that used it at the base, placed against every exported symbol's fan-in. The band is the highest of these.",
    why: "A flaw in widely used code is inherited by every consumer.",
  },
  {
    name: "complexity-delta",
    family: "structure-and-content",
    layer: "lexical",
    banding: "count",
    signal: "Units that are new and over a guideline, or over a guideline and worse",
    definition: "With the complexity plugin's diff passed in: the units it reports as new and over its guideline, or over it and worse. Without it: the touched code files (those a lexer profile reads, so not prose or licence text) whose indentation complexity rose by at least cochange.risk.complexityRise. Banded on the count, and not counted in the score.",
    why: "The change is adding code that is hard to understand.",
  },
  {
    name: "structure-delta",
    family: "structure-and-content",
    layer: "structural",
    banding: "count",
    signal: "New cycles and layer violations",
    definition: "From the structure plugin's check, passed in with --evidence. Unavailable without it. Any new cycle or violation is an event that raises the impact band, and it is not also counted in the score.",
    why: "The change makes later changes more expensive.",
  },
  {
    name: "sensitive-paths",
    family: "structure-and-content",
    layer: "history",
    banding: "count",
    signal: "Touched files matching the configured sensitive globs",
    definition: "Touched files (or their old paths) matching cochange.risk.sensitivePaths: migrations, authentication, build and CI configuration, dependency manifests. Any match is an event that raises the impact band, and it is not also counted in the score.",
    why: "Some paths carry consequences that no history signal captures.",
  },
  {
    name: "authorship",
    family: "placement",
    layer: "placement",
    banding: "none",
    signal: "Share of each touched file's lines last authored by the change's authors",
    definition: "From the blame cache at the base: lines last written by the authors, over the lines held by people, per touched file. Lines held by bots, services and agents belong to nobody.",
    why: "The author is modifying code they wrote.",
  },
  {
    name: "change-familiarity",
    family: "placement",
    layer: "placement",
    banding: "none",
    signal: "The authors' earlier changes to each touched file, weighted by recency",
    definition: "Each earlier merged change of a touched file by one of the authors counts 1, halved for every cochange.risk.recencyHalfLifeMonths it is old.",
    why: "Familiarity fades, so a change from three years ago counts for less than one from last month.",
  },
  {
    name: "neighbourhood",
    family: "placement",
    layer: "placement",
    banding: "none",
    signal: "The authors' earlier changes to files coupled with the touched files, to the same folder, and to the same configured component",
    definition: "The authors' earlier changes to the files that changed with the touched file at the missing-co-change guidelines, to files in its folder, and to files in its component when cochange components are configured.",
    why: "Someone who knows the surroundings is better placed than a file-level count shows.",
  },
  {
    name: "first-touch-share",
    family: "placement",
    layer: "placement",
    banding: "none",
    signal: "Share of the change's churn in first-touch files",
    definition: "The churn in files whose label is first-touch, over the change's churn.",
    why: "The part of the change made without any history in that code.",
  },
  {
    name: "owner-distance",
    family: "placement",
    layer: "placement",
    banding: "none",
    signal: "Touched files with a clear owner who is not among the change's authors",
    definition: "Touched files where one active developer holds at least cochange.risk.ownerShare percent of the lines and is not an author of the change.",
    why: "Low-ownership changes to owned code are where the ownership research finds more failures, and the owner is the obvious reviewer.",
  },
  {
    name: "no-owner",
    family: "placement",
    layer: "placement",
    banding: "none",
    signal: "Touched files with no active developer holding a meaningful share",
    definition: "Touched files where no active developer holds at least cochange.risk.regularShare percent of the lines.",
    why: "Neither the author nor any reviewer has first-hand knowledge.",
  },
];

export const factorDoc = (name: string): FactorDoc | undefined => FACTOR_DOCS.find((doc) => doc.name === name);

/** The rules behind the level, printed in full by `risk explain`. */
export const LEVEL_RULES: readonly { id: string; text: string }[] = [
  {
    id: "baseline",
    text: "The baseline population is the repository's past changes as they were merged: the commits a merge commit brought in, taken together, or a squash commit, or a single commit on the main line. The most recent cochange.risk.baselineChanges of them inside the analysis window form it, each measured as of its own time.",
  },
  {
    id: "bands",
    text: "A factor's value is placed against the baseline: above the cochange.risk.moderatePercentile (default 75th) is moderate, above the highPercentile (default 90th) is high. The comparison is strict, percentiles are nearest rank, and a value of zero is always low. Count-based factors band on the count: cochange.risk.countModerate and countHigh. A two-sided factor takes the higher of its sides.",
  },
  {
    id: "unavailable",
    text: "A factor that cannot be computed, or whose value cannot be placed because fewer than cochange.risk.minBaseline merged changes could be compared, is unavailable. It is never reported as low and it adds nothing to the score.",
  },
  {
    id: "families",
    text: "Factors that measure nearly the same thing form a family: size and diffusion, history of the touched code, completeness, and structure and content. A family counts once, at the band of its highest scored factor (low 0, moderate 1, high 2). The score is the sum.",
  },
  {
    id: "impact",
    text: "The impact band is the score placed against the baseline's own scores, by the same strict percentiles. By construction no more than a quarter of changes are moderate or above and no more than a tenth are high, however many factors there are.",
  },
  {
    id: "events",
    text: "Three findings are events, not positions in a distribution: a high missing-co-change, any structure-delta, and any sensitive-paths match. Together they raise the impact band by one step, once. sensitive-paths, structure-delta and complexity-delta are not also counted in the score.",
  },
  {
    id: "placement",
    text: "Placement is close when most of the change's churn is in owner or regular files, distant when most is in first-touch files or no-owner is high, mixed otherwise, and unknown when most files are unknown. It is computed for the invoking user's own change, or for anyone's when cochange.risk.placement is any.",
  },
  {
    id: "level",
    text: "Impact low: routine when placement is close or mixed or unknown, attention when distant. Impact moderate: routine when close, attention when mixed or unknown, elevated when distant. Impact high: attention when close, elevated otherwise.",
  },
  {
    id: "backtest",
    text: "No level is shown until cochange risk backtest has been run on the repository and its stored result shows that the levels separate past changes. Until then the bands, findings and responses stand alone. The level is advice for review, never a gate.",
  },
];
