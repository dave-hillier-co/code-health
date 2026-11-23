import { isCodePath } from "@code-health/parse/code-files";
import { hasAdapter } from "@code-health/parse/languages";
import { folderOf, treeDistance } from "@code-health/graph/tree-distance";
import type { FixMatch } from "@code-health/history/fix-commits";
import { monthsBefore } from "@code-health/history/evidence";
import { compileGlobs } from "@code-health/history/glob";
import type { HistoryChange } from "@code-health/history/read";
import { expectedReason, folderPrefix, listsSourceFiles } from "../expected-pair.ts";
import { componentOf, type Component } from "../components.ts";
import { isTestPath, siblingTestOf } from "../sibling-test.ts";
import { changeSpread } from "../spread-measure.ts";
import { SECONDS_PER_DAY } from "../units.ts";
import type { HistoryState } from "./history-state.ts";
import type { RiskSettings } from "./settings.ts";

export type Family = "size-and-diffusion" | "history" | "completeness" | "structure-and-content" | "placement";
export type Layer = "history" | "lexical" | "structural" | "placement";
export type Kind = "percentile" | "count";

/** A change reduced to what the factors read. A past merged change and a branch under review look alike. */
export interface ChangeFacts {
  /** Unix seconds the change is assessed at: a past change's merge date, or the branch tip's date. */
  time: number;
  /** Lower-case mapped author emails of the change. */
  authors: readonly string[];
  /** Files after the noise filters, pure renames left out. */
  files: readonly HistoryChange[];
  /** Files moved or renamed, pure renames included when the source can see them. */
  moved: number;
  /** Paths that exist after the change, besides those in `files`: files it adds are in `files`. Not used for past changes. */
  extraPaths?: ReadonlySet<string>;
}

/** What `measure` needs besides the change and the history. */
export interface MeasureContext {
  risk: RiskSettings;
  minSupport: number;
  windowMonths: number;
  recentMonths: number;
  staleMonths: number;
  hotspotPercentile: number;
  components: readonly Component[];
  /** The configured language adapters: a hot file counts only when one of them claims it as code, as in the hotspot ranking. */
  languages?: Readonly<Record<string, string>>;
}

/**
 * One factor's measurement, before it is placed against the baseline. `series` holds the numbers that
 * are banded: one for most factors, two for a two-sided factor such as `age`.
 */
export interface Measurement {
  name: string;
  family: Family;
  layer: Layer;
  kind: Kind;
  /** Why the factor could not be computed. A factor with a reason has no series and is never `low`. */
  unavailable: string | null;
  series: Record<string, number>;
  value: Record<string, number | string[] | null>;
  evidence: Record<string, unknown>[];
  source: string;
}

const round = (value: number, places = 6): number => Math.round(value * 10 ** places) / 10 ** places;
const churnOf = (file: HistoryChange): number => (file.added ?? 0) + (file.deleted ?? 0);
const FIRST_ROWS = 5;

function measurement(
  name: string,
  family: Family,
  layer: Layer,
  kind: Kind,
  source: string,
  parts: Partial<Pick<Measurement, "series" | "value" | "evidence" | "unavailable">>,
): Measurement {
  return { name, family, layer, kind, source, unavailable: null, series: {}, value: {}, evidence: [], ...parts };
}

const unavailable = (name: string, family: Family, layer: Layer, kind: Kind, source: string, reason: string): Measurement =>
  measurement(name, family, layer, kind, source, { unavailable: reason });

/** The history-layer factors of a change, read from the history before it. Never touches git. */
export function measureHistoryLayer(facts: ChangeFacts, state: HistoryState, context: MeasureContext): Measurement[] {
  return [
    size(facts),
    spread(facts, context),
    entropy(facts),
    mixedPurpose(facts),
    hotspotsTouched(facts, state, context),
    defectHistory(facts, state, context),
    contention(facts, state, context),
    age(facts, state, context),
    missingCoChange(facts, state, context),
    novelCoupling(facts, state, context),
    testEvidence(facts, state, context),
    blastRadius(facts, state, context),
    sensitivePaths(facts, context),
  ];
}

function size(facts: ChangeFacts): Measurement {
  const lines = facts.files.reduce((sum, file) => sum + churnOf(file), 0);
  return measurement("size", "size-and-diffusion", "history", "percentile", "history", {
    series: { lines },
    value: { lines, files: facts.files.length },
  });
}

function spread(facts: ChangeFacts, context: MeasureContext): Measurement {
  const paths = facts.files.map((file) => file.path);
  const value = round(changeSpread(paths));
  const folders = new Set(paths.map(folderOf)).size;
  const components = context.components.length === 0 ? null : new Set(paths.map((path) => componentOf(context.components, path))).size;
  return measurement("spread", "size-and-diffusion", "history", "percentile", "history", {
    series: { spread: value },
    value: { spread: value, folders, components },
  });
}

function entropy(facts: ChangeFacts): Measurement {
  const churn = facts.files.map(churnOf).filter((c) => c > 0);
  const total = churn.reduce((sum, c) => sum + c, 0);
  const value = total === 0 ? 0 : round(churn.reduce((sum, c) => sum - (c / total) * Math.log2(c / total), 0));
  return measurement("entropy", "size-and-diffusion", "history", "percentile", "history", {
    series: { entropy: value },
    value: { entropy: value, files: churn.length },
  });
}

function mixedPurpose(facts: ChangeFacts): Measurement {
  const moved = facts.moved;
  const edited = facts.files.filter((file) => churnOf(file) > 0 && file.status !== "R").length;
  const editedWhileMoved = facts.files.filter((file) => file.status === "R" && churnOf(file) > 0).length;
  const mixed = moved > 0 && (edited > 0 || editedWhileMoved > 0);
  const count = mixed ? moved : 0;
  return measurement("mixed-purpose", "size-and-diffusion", "history", "count", "history", {
    series: { count },
    value: { moved, edited, editedWhileMoved },
    evidence: mixed
      ? facts.files
          .filter((file) => file.status === "R")
          .slice(0, FIRST_ROWS)
          .map((file) => ({ file: file.path, from: file.oldPath }))
      : [],
  });
}

function hotspotsTouched(facts: ChangeFacts, state: HistoryState, context: MeasureContext): Measurement {
  const recentSince = monthsBefore(facts.time, context.recentMonths);
  const line = state.hotRevisionCount((100 - context.hotspotPercentile) / 100);
  const busy = facts.files.filter((file) => {
    const last = state.lastChanged(file.fileId);
    return state.present(file.fileId) && last !== null && last >= recentSince && state.revisionsInWindow(file.fileId) >= line;
  });
  // The hotspot ranking leaves out files that are not code (a changelog, a manifest, data), so a hot file here is code too.
  const hot = busy.filter((file) => isCodePath(file.fileId, context.languages));
  const nonCodeHot = busy.length - hot.length;
  const total = facts.files.reduce((sum, file) => sum + churnOf(file), 0);
  const inHot = hot.reduce((sum, file) => sum + churnOf(file), 0);
  const share = total === 0 ? 0 : round(inHot / total);
  return measurement("hotspots-touched", "history", "history", "percentile", "history", {
    series: { share },
    value: { share, hotFiles: hot.length, ...(nonCodeHot > 0 ? { nonCodeHotFiles: nonCodeHot } : {}) },
    evidence: hot
      .map((file) => ({ file: file.fileId, revisions: state.revisionsInWindow(file.fileId) }))
      .sort((a, b) => b.revisions - a.revisions || (a.file < b.file ? -1 : 1))
      .slice(0, FIRST_ROWS),
  });
}

/** The most recent matching commits each file of `defect-history` lists, with how many more matched. */
const FIX_COMMITS_PER_FILE = 3;

function defectHistory(facts: ChangeFacts, state: HistoryState, context: MeasureContext): Measurement {
  if (state.windowSummary().fixes === 0) {
    return unavailable("defect-history", "history", "history", "percentile", "history", "no change in the window matches a fix pattern, so the commit messages cannot say which revisions were fixes");
  }
  const since = facts.time - context.windowMonths * 30.4375 * SECONDS_PER_DAY;
  let revisions = 0;
  let fixes = 0;
  const perFile: { file: string; fixes: number; revisions: number; commits: FixMatch[]; omitted: number }[] = [];
  for (const file of facts.files) {
    const own = state.revisionsSince(file.fileId, since);
    const matches = own.flatMap((revision) => revision.fix ?? []);
    const fixed = matches.length;
    revisions += own.length;
    fixes += fixed;
    if (fixed > 0) perFile.push({ file: file.fileId, fixes: fixed, revisions: own.length, commits: matches.slice(-FIX_COMMITS_PER_FILE).reverse(), omitted: Math.max(0, fixed - FIX_COMMITS_PER_FILE) });
  }
  const share = revisions === 0 ? 0 : round(fixes / revisions);
  return measurement("defect-history", "history", "history", "percentile", "history", {
    series: { share },
    value: { share, fixes, revisions },
    evidence: perFile.sort((a, b) => b.fixes - a.fixes || (a.file < b.file ? -1 : 1)).slice(0, FIRST_ROWS),
  });
}

function contention(facts: ChangeFacts, state: HistoryState, context: MeasureContext): Measurement {
  const since = monthsBefore(facts.time, context.recentMonths);
  const own = new Set(facts.authors);
  const others = new Set<string>();
  const perFile: { file: string; authors: number }[] = [];
  for (const file of facts.files) {
    const here = new Set<string>();
    for (const revision of state.revisionsSince(file.fileId, since)) {
      for (const author of revision.authors) if (!own.has(author.toLowerCase())) here.add(author.toLowerCase());
    }
    for (const author of here) others.add(author);
    if (here.size > 0) perFile.push({ file: file.fileId, authors: here.size });
  }
  return measurement("contention", "history", "history", "percentile", "history", {
    series: { authors: others.size },
    value: { authors: others.size },
    evidence: perFile.sort((a, b) => b.authors - a.authors || (a.file < b.file ? -1 : 1)).slice(0, FIRST_ROWS),
  });
}

function age(facts: ChangeFacts, state: HistoryState, context: MeasureContext): Measurement {
  const staleBefore = monthsBefore(facts.time, context.staleMonths);
  const settlingFrom = facts.time - context.risk.settlingDays * SECONDS_PER_DAY;
  const known = facts.files.filter((file) => state.known(file.fileId) && state.present(file.fileId));
  const stale = known.filter((file) => state.lastChanged(file.fileId)! < staleBefore);
  const settling = known.filter((file) => state.lastChanged(file.fileId)! >= settlingFrom);
  const share = (n: number) => (known.length === 0 ? 0 : round(n / known.length));
  return measurement("age", "history", "history", "percentile", "history", {
    series: { stale: share(stale.length), settling: share(settling.length) },
    value: { stale: stale.length, settling: settling.length, known: known.length },
    evidence: [
      ...stale.slice(0, FIRST_ROWS).map((file) => ({ file: file.fileId, side: "stale" })),
      ...settling.slice(0, FIRST_ROWS).map((file) => ({ file: file.fileId, side: "settling" })),
    ],
  });
}

interface Partner {
  file: string;
  towards: string;
  confidence: number;
  support: number;
}

/**
 * Files that changed with a touched file at the configured confidence and support, over the eligible
 * changes of the window. One entry per partner, naming the touched file it is strongest towards.
 */
function coupledPartners(facts: ChangeFacts, state: HistoryState, context: MeasureContext): Partner[] {
  const best = new Map<string, Partner>();
  for (const file of facts.files) {
    if (file.status === "D") continue;
    const revisions = state.eligibleRevisionsInWindow(file.fileId);
    if (revisions === 0) continue;
    for (const [other, support] of state.partners(file.fileId)) {
      // Exact integer arithmetic: a pair at the guideline is never lost to rounding.
      if (support < context.minSupport || 100 * support < context.risk.missingConfidence * revisions) continue;
      if (!state.present(other)) continue;
      const confidence = round((100 * support) / revisions, 1);
      const current = best.get(other);
      if (!current || confidence > current.confidence || (confidence === current.confidence && file.fileId < current.towards)) {
        best.set(other, { file: other, towards: file.fileId, confidence, support });
      }
    }
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence || b.support - a.support || (a.file < b.file ? -1 : 1));
}

/**
 * A build manifest that lists sources (`CMakeLists.txt`, `Makefile`) changes with its sources mostly because sources
 * are added to it or removed from it. It is expected to change with a source file only when the change adds, removes or
 * renames a code file in its folder or below.
 */
function manifestExpected(manifest: string, facts: ChangeFacts): boolean {
  const folder = folderPrefix(manifest);
  return facts.files.some((file) => {
    if (file.status !== "A" && file.status !== "D" && file.status !== "R") return false;
    const paths = file.oldPath === null ? [file.path] : [file.path, file.oldPath];
    return paths.some((path) => path.startsWith(folder) && !listsSourceFiles(path) && hasAdapter(path));
  });
}

/**
 * Whether a partner and the touched file it is strongest towards are build or packaging manifests of one toolchain
 * (`go.mod` and `go.work`, `package.json` and a lockfile), by the same rule the coupling report uses for its
 * `build-manifests` expected pairs. Such files change together when a dependency changes, and a change that edits one
 * without the other is common. A lockfile missing from a change that edits its manifest's dependency list is a real
 * expectation, but the change facts carry no diff, so it is skipped with the other manifests.
 */
function sameToolchainManifests(partner: Partner, facts: ChangeFacts): boolean {
  const touched = facts.files.find((file) => file.fileId === partner.towards);
  const never = () => false;
  return touched !== undefined && expectedReason({ path: touched.path, code: false }, { path: partner.file, code: false }, never) === "build-manifests";
}

/**
 * The files missing from the change, and how many partners were skipped because the pairing is with a build manifest
 * that lists sources. A manifest partner of a touched file counts only when the change adds, removes or renames a code
 * file in its folder or below; a touched manifest is not a reason to expect its sources, because the edit is mostly the
 * line that adds or removes the source the change already contains. The skipped partners are counted, not dropped.
 */
function missingCoChange(facts: ChangeFacts, state: HistoryState, context: MeasureContext): Measurement {
  const touched = new Set(facts.files.map((file) => file.fileId));
  const absent = coupledPartners(facts, state, context).filter((partner) => !touched.has(partner.file));
  const withoutManifests = coupledPartners({ ...facts, files: facts.files.filter((file) => !listsSourceFiles(file.fileId)) }, state, context);
  const candidates = withoutManifests.filter((partner) => !touched.has(partner.file) && (!listsSourceFiles(partner.file) || manifestExpected(partner.file, facts)));
  const missing = candidates.filter((partner) => !sameToolchainManifests(partner, facts));
  const skipped = absent.length - candidates.length;
  const toolchainSkipped = candidates.length - missing.length;
  return measurement("missing-co-change", "completeness", "history", "count", "history", {
    series: { count: missing.length },
    value: {
      count: missing.length,
      ...(skipped === 0 ? {} : { manifestPartnersSkipped: skipped }),
      ...(toolchainSkipped === 0 ? {} : { buildManifestPartnersSkipped: toolchainSkipped }),
    },
    evidence: missing.map((partner) => ({ file: partner.file, towards: partner.towards, confidence: partner.confidence, support: partner.support })),
  });
}

function novelCoupling(facts: ChangeFacts, state: HistoryState, context: MeasureContext): Measurement {
  const files = facts.files.filter((file) => file.status !== "D" && state.known(file.fileId));
  const pairs: { a: string; b: string; distance: number }[] = [];
  for (const [i, a] of files.entries()) {
    for (const b of files.slice(i + 1)) {
      const distance = treeDistance(a.path, b.path);
      if (distance >= context.risk.novelDistance && !state.everTogether(a.fileId, b.fileId)) pairs.push({ a: a.fileId, b: b.fileId, distance });
    }
  }
  pairs.sort((x, y) => y.distance - x.distance || (x.a + x.b < y.a + y.b ? -1 : 1));
  return measurement("novel-coupling", "completeness", "history", "count", "history", {
    series: { count: pairs.length },
    value: { count: pairs.length },
    evidence: pairs.slice(0, FIRST_ROWS).map((pair) => ({ ...pair })),
  });
}

function testEvidence(facts: ChangeFacts, state: HistoryState, context: MeasureContext): Measurement {
  const touched = new Set(facts.files.map((file) => file.fileId));
  const exists = { has: (path: string) => touched.has(path) || state.present(path) };
  const rows: Record<string, unknown>[] = [];
  for (const file of facts.files) {
    if (file.status === "D" || isTestPath(file.path)) continue;
    const test = siblingTestOf(file.path, exists);
    if (test === null || touched.has(test)) continue;
    const revisions = state.eligibleRevisionsInWindow(file.fileId);
    const together = state.support(file.fileId, test);
    if (revisions >= context.minSupport && 100 * together >= context.risk.testShare * revisions) {
      rows.push({ file: file.fileId, test, kind: "not-updated", together, revisions });
    }
  }
  for (const file of facts.files) if (file.status === "D" && isTestPath(file.path)) rows.push({ file: file.fileId, test: file.fileId, kind: "deleted" });
  rows.sort((a, b) => (String(a.file) < String(b.file) ? -1 : 1));
  return measurement("test-evidence", "completeness", "history", "count", "history", {
    series: { count: rows.length },
    value: { count: rows.length },
    evidence: rows,
  });
}

function blastRadius(facts: ChangeFacts, state: HistoryState, context: MeasureContext): Measurement {
  const partners = coupledPartners(facts, state, context);
  return measurement("blast-radius", "structure-and-content", "history", "percentile", "co-change", {
    series: { files: partners.length },
    value: { files: partners.length },
    evidence: partners.slice(0, FIRST_ROWS).map((partner) => ({ file: partner.file, towards: partner.towards, confidence: partner.confidence })),
  });
}

function sensitivePaths(facts: ChangeFacts, context: MeasureContext): Measurement {
  const matches = compileGlobs(context.risk.sensitivePaths);
  const hits = facts.files.filter((file) => matches(file.path) || (file.oldPath !== null && matches(file.oldPath))).map((file) => file.path).sort();
  return measurement("sensitive-paths", "structure-and-content", "history", "count", "configured globs", {
    series: { count: hits.length },
    value: { count: hits.length },
    evidence: hits.map((file) => ({ file })),
  });
}
