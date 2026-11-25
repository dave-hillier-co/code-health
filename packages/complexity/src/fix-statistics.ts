import { analyseHistory, monthsBefore } from "@code-health/history/evidence";
import { checkFixConvention, findExcludedFix, findFix, fixEvidence, type FixConvention, type FixEvidence, type FixMatch } from "@code-health/history/fix-commits";
import { groupByLanding, landingOf, readLandings } from "@code-health/history/landings";
import { runGit } from "@code-health/history/git";
import type { LogicalChange } from "@code-health/history/noise";
import type { HistoryCommit } from "@code-health/history/read";
import { readShallowInfo, refresh } from "@code-health/history/refresh";
import { GrammarSet } from "@code-health/parse/grammars";
import { adapterForPath } from "@code-health/parse/languages";
import { ParseCache } from "@code-health/parse/parse-cache";
import { readBlobs, restrictTree, treeFromTexts, type SourceTree } from "@code-health/parse/source-tree";
import type { ComplexitySettings } from "./config.ts";
import { pathSelector } from "./current-tree.ts";
import { parseDiffs, touchedUnits, type FileDiff } from "./fix-ranges.ts";
import { matchUnits, type BodyCache } from "./match-units.ts";
import { measureTree, type FileRecord, type UnitRecord } from "./measure.ts";

/** Rows kept in each secondary list, deleted units and files with fixes outside any unit. The output says how many were left out. */
export const SECONDARY_LIST_LIMIT = 10;

const DIFF_BATCH = 200;

export interface FixRequest {
  /** Repo-relative paths or directories, by their names at HEAD. None selects every file. */
  paths: readonly string[];
  /** Most commits to analyse, newest first. Null analyses the whole window. */
  maxCommits: number | null;
  /** Evidence commits to keep per unit. */
  evidence: number;
}

export interface FixEvidenceRow {
  sha: string;
  /** Committer date, as `YYYY-MM-DD`. */
  date: string;
  subject: string;
  pattern: string;
  matchedIn: "subject" | "body";
}

/** What the window's history says about one function, followed forward to the current revision. */
export interface UnitFixes {
  id: string;
  path: string;
  /** Present for a unit that still exists. */
  current: UnitRecord | undefined;
  /** Landed changes in the analysed window that are fixes by their own title, and touched the unit. */
  fixCommits: number;
  /** Landed changes in the analysed window that touched the unit, fixes included. The denominator of `fixShare`. */
  revisions: number;
  fixShare: number | null;
  evidence: FixEvidenceRow[];
  evidenceOmitted: number;
  /** Fix-like commits made on a branch before it merged that changed lines of the unit. Caught in review, so not in `fixCommits`. */
  reviewFixes: number;
  reviewEvidence: FixEvidenceRow[];
  reviewEvidenceOmitted: number;
  /** Other ids the unit had earlier in the window, from a rename or a move. */
  earlierIds: string[];
}

export interface OutsideUnits {
  path: string;
  fixCommits: number;
  /** Logical changes with a changed line outside every function of the file. */
  revisions: number;
}

export interface FixStatistics {
  window: { months: number; since: number; until: number };
  convention: FixConvention;
  /** Landed changes of the window that a fix pattern matched and an exclude pattern removed (`history.fixExcludePatterns`), by the excluding pattern. They are not fixes. */
  excluded: FixEvidence;
  /** Revisions below which a unit's fix figures are labelled low evidence (`fixes.minRevisions`). */
  minRevisions: number;
  /** History before the window start is missing because the clone is shallow. */
  shallow: boolean;
  commits: {
    /** Commits of the logical changes that touched the selected files. */
    inWindow: number;
    analysed: number;
    skipped: number;
    skippedBy: { maxCommits: number; oversized: number; noSourceFile: number };
  };
  /** File revisions the analysed commits changed, and the ones that could not be mapped onto functions, by cause. */
  files: { analysed: number; skipped: { binary: number; large: number; excluded: number; tests: number; noAdapter: number } };
  cache: { parsed: number; cached: number };
  /** Units that still exist and were touched in the window, by current id. */
  units: Map<string, UnitFixes>;
  /** The landed changes of the window that touched each unit that still exists, by current id. The size of the intersection of two sets is the changes the two functions shared. */
  changes: Map<string, ReadonlySet<string>>;
  /** Units no longer in the current revision that the window touched. */
  deleted: UnitFixes[];
  /** `fixCommits` is the distinct fix changes with a changed line outside every function, so it never exceeds the fixes of the window. `fixFileChanges` is the sum of the files' counts, where a change touching three files counts three times. */
  outside: { fixCommits: number; fixFileChanges: number; files: OutsideUnits[] };
  /** Units touched at least once, and the ones with at least one fix. Deleted units included. */
  unitsTouched: number;
  unitsWithFixes: number;
}

interface Touch {
  /** The landed change the commit belongs to. */
  changeId: string;
  sha: string;
  fileId: string;
  path: string;
  blob: string;
  /** The commit created the file: every unit counts as touched once, and none as fixed. */
  added: boolean;
  /** The file's blob before the commit, when the commit changed an existing file. */
  oldBlob: string | undefined;
  ranges: FileDiff["ranges"];
}

interface Aggregate {
  changes: Set<string>;
  fixes: Set<string>;
  /** Fix-like commits of merged branches that changed lines of the unit. */
  review: Set<string>;
  ids: Set<string>;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const day = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);
const utf8 = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** A unit with fewer revisions than `minRevisions` has too little history for its fix share to mean much. */
export const isLowEvidence = (fixes: UnitFixes, minRevisions: number): boolean => fixes.revisions < minRevisions;

/** Fix count, then units with enough revisions before low evidence ones, then fix share, then id, which is the order of every list of units. */
export function byFixes(minRevisions: number): (a: UnitFixes, b: UnitFixes) => number {
  return (a, b) =>
    b.fixCommits - a.fixCommits ||
    Number(isLowEvidence(a, minRevisions)) - Number(isLowEvidence(b, minRevisions)) ||
    (b.fixShare ?? 0) - (a.fixShare ?? 0) ||
    utf8(a.id, b.id);
}

/**
 * Matches some units of an earlier revision of a file with some of a later one. The earlier units are given the later path first, so
 * a file renamed in git keeps its functions by identity and only a function renamed inside it is matched by body. Returns, for each
 * earlier unit, the later unit it became, or undefined when none did.
 */
function followUnits(
  earlier: FileRecord,
  earlierUnits: readonly UnitRecord[],
  later: FileRecord,
  laterUnits: readonly UnitRecord[],
  threshold: number,
  cache: BodyCache,
): { before: UnitRecord; after: UnitRecord | undefined }[] {
  const original = new Map<string, UnitRecord>();
  const moved = earlierUnits.map((unit) => {
    const relocated = { ...unit, path: later.path, id: `${later.path}${unit.id.slice(earlier.path.length)}` };
    original.set(relocated.id, unit);
    return relocated;
  });
  const matches = matchUnits([{ ...earlier, path: later.path, units: moved }], [{ ...later, units: [...laterUnits] }], threshold, cache);
  return matches.flatMap((match) => (match.before === undefined ? [] : [{ before: original.get(match.before.id)!, after: match.after }]));
}

async function diffsOf(root: string, shas: readonly string[]): Promise<Map<string, Map<string, FileDiff>>> {
  const diffs = new Map<string, Map<string, FileDiff>>();
  for (let start = 0; start < shas.length; start += DIFF_BATCH) {
    const input = `${shas.slice(start, start + DIFF_BATCH).join("\n")}\n`;
    const out = await runGit(root, ["-c", "core.quotePath=false", "diff-tree", "--stdin", "-p", "-U0", "-M", "--no-color", "--no-ext-diff", "--full-index", "--root", "-r"], { input });
    for (const [sha, files] of parseDiffs(out)) diffs.set(sha, files);
  }
  return diffs;
}

/**
 * Per-function fix statistics over the history window, in the manner of CodeScene's X-Ray. For each logical change in
 * the window that touched a source file, the changed lines of the new revision (`git diff -U0` against the first parent)
 * are mapped onto the functions that contain them, each function is followed forward to the current revision with the
 * unit matcher, and a change that matches the shared fix definition counts as a fix for every function it touched.
 *
 * The work is bounded by the window and by `maxCommits`, newest first, and the output says how many commits were left out.
 * Every historical blob is parsed through the shared parse cache, keyed by blob, so a rerun parses nothing it has seen.
 */
export async function measureFixes(
  root: string,
  settings: ComplexitySettings,
  exclude: readonly string[],
  current: SourceTree,
  request: FixRequest,
): Promise<FixStatistics> {
  await refresh(root, { ref: "HEAD" });
  const history = await analyseHistory(root, { ref: "HEAD", noise: { exclude: [...exclude], botPatterns: settings.botPatterns, maxChangesetSize: settings.maxChangesetSize } });
  const shallow = (await readShallowInfo(root)).isShallow;
  const until = history.view.headDate;
  const since = monthsBefore(until, settings.windowMonths);
  const window = { months: settings.windowMonths, since, until };
  const inWindow = history.filtered.changes.filter((change) => change.committerDate >= since && change.committerDate <= until);

  const commitBySha = new Map<string, HistoryCommit>(history.view.commits.map((commit) => [commit.sha, commit] as const));
  // Fixes are counted per change that landed on the main line, by the change's own title. `fixOf` and `landedById` are keyed by the landing's commit.
  const landings = await readLandings(root, history.view.headSha);
  const landingBySha = landingOf(landings);
  const landedById = new Map(landings.map((landing) => [landing.id, landing] as const));
  const fixOf = new Map<string, FixMatch | null>();
  const excludedMatches: FixMatch[] = [];
  const reviewFixOf = new Map<string, FixMatch>();
  const landed = groupByLanding(inWindow, landings);
  for (const { landing } of landed) {
    const found = findFix(settings.fix, landing.id, [landing.text]);
    fixOf.set(landing.id, found);
    if (found === null) {
      const excluded = findExcludedFix(settings.fix, landing.id, [landing.text]);
      if (excluded !== null) excludedMatches.push(excluded);
    }
    for (const { sha, message } of landing.branch) {
      const review = findFix(settings.fix, sha, [message]);
      if (review !== null) reviewFixOf.set(sha, review);
    }
  }
  const convention = checkFixConvention(landed.map(({ landing }) => landing.text), [...fixOf.values()].filter((found) => found !== null).length);

  const selected = pathSelector(request.paths);
  const analysable = (path: string): boolean => adapterForPath(path) !== undefined && !settings.isExcluded(path) && (settings.analyseTests || !settings.isTest(path));
  const sourceFiles = (change: LogicalChange) => change.files.filter((file) => selected(file.fileId) && analysable(file.path));

  const relevant = inWindow.filter((change) => change.files.some((file) => selected(file.fileId)));
  const commits = { inWindow: relevant.reduce((sum, change) => sum + change.shas.length, 0), analysed: 0, skipped: 0, skippedBy: { maxCommits: 0, oversized: 0, noSourceFile: 0 } };
  const analysed: LogicalChange[] = [];
  for (const change of [...relevant].sort((a, b) => b.committerDate - a.committerDate || utf8(a.id, b.id))) {
    if (change.oversized) commits.skippedBy.oversized += change.shas.length;
    else if (sourceFiles(change).length === 0) commits.skippedBy.noSourceFile += change.shas.length;
    else if (commits.analysed > 0 && commits.analysed + change.shas.length > (request.maxCommits ?? Infinity)) commits.skippedBy.maxCommits += change.shas.length;
    else {
      commits.analysed += change.shas.length;
      analysed.push(change);
    }
  }
  commits.skipped = commits.skippedBy.maxCommits + commits.skippedBy.oversized + commits.skippedBy.noSourceFile;

  const diffs = await diffsOf(root, analysed.flatMap((change) => change.shas));

  // Newest first, so the first touch of a file is its latest revision in the window.
  const touches: Touch[] = [];
  for (const change of analysed) {
    const fileIds = new Set(sourceFiles(change).map((file) => file.fileId));
    for (const sha of change.shas) {
      const landing = landingBySha.get(sha);
      if (landing === undefined) continue;
      for (const file of commitBySha.get(sha)?.changes ?? []) {
        if (file.status === "D" || file.binary || file.blob === null || !fileIds.has(file.fileId)) continue;
        const diff = diffs.get(sha)?.get(file.path);
        const added = file.status === "A" || diff?.added === true;
        if (!added && (diff === undefined || diff.ranges.length === 0)) continue;
        touches.push({ changeId: landing.id, sha, fileId: file.fileId, path: file.path, blob: file.blob, added, oldBlob: added ? undefined : diff?.oldBlob, ranges: diff?.ranges ?? [] });
      }
    }
  }

  const grammars = new GrammarSet();
  const cache = await ParseCache.forRepository(root);
  const cacheStats = { parsed: 0, cached: 0 };
  const skipped = { binary: 0, large: 0, excluded: 0, tests: 0, noAdapter: 0 };
  const measureOptions = { settings, layer: "structural", cache, keepText: true, grammars } as const;

  const fileIds = [...new Set(touches.map((touch) => touch.fileId))].sort(utf8);
  const currentMeasure = await measureTree(restrictTree(current, fileIds), measureOptions);
  cacheStats.parsed += currentMeasure.stats.parsed;
  cacheStats.cached += currentMeasure.stats.cached;
  const currentFiles = new Map(currentMeasure.files.map((file) => [file.path, file] as const));
  const currentUnits = new Map(currentMeasure.files.flatMap((file) => file.units).map((unit) => [unit.id, unit] as const));

  // One measurement per distinct blob. A path with several revisions goes in a layer each, so a layer has unique paths.
  const pairKey = (path: string, blob: string): string => `${path}\0${blob}`;
  const blobsByPath = new Map<string, string[]>();
  const touchesByPair = new Map<string, Touch[]>();
  const latestPair = new Map<string, string>();
  const fileOfPair = new Map<string, string>();
  for (const touch of touches) {
    const blobs = blobsByPath.get(touch.path) ?? [];
    if (!blobs.includes(touch.blob)) blobs.push(touch.blob);
    blobsByPath.set(touch.path, blobs);
    const key = pairKey(touch.path, touch.blob);
    const pairTouches = touchesByPair.get(key);
    if (pairTouches === undefined) touchesByPair.set(key, [touch]);
    else pairTouches.push(touch);
    if (!latestPair.has(touch.fileId)) latestPair.set(touch.fileId, key);
    fileOfPair.set(key, touch.fileId);
  }

  const bodyCache: BodyCache = new Map();
  // The revision before each fix, so a function the fix created is not counted as fixed by it, as a file the commit created is not.
  const isFixLike = (touch: Touch): boolean => (fixOf.get(touch.changeId) ?? null) !== null || reviewFixOf.has(touch.sha);
  const parentBlobsByPath = new Map<string, string[]>();
  for (const touch of touches) {
    if (touch.added || touch.oldBlob === undefined || !isFixLike(touch)) continue;
    const blobs = parentBlobsByPath.get(touch.path) ?? [];
    if (!blobs.includes(touch.oldBlob)) blobs.push(touch.oldBlob);
    parentBlobsByPath.set(touch.path, blobs);
  }
  const parents = new Map<string, FileRecord>();
  const parentLayers = Math.max(0, ...[...parentBlobsByPath.values()].map((blobs) => blobs.length));
  for (let layer = 0; layer < parentLayers; layer++) {
    const wanted = [...parentBlobsByPath].flatMap(([path, blobs]) => (blobs[layer] === undefined ? [] : [{ path, blob: blobs[layer]! }]));
    const texts = await readBlobs(root, wanted.map((entry) => entry.blob));
    const tree = treeFromTexts(Object.fromEntries(wanted.flatMap((entry) => (texts.has(entry.blob) ? [[entry.path, texts.get(entry.blob)!]] : []))));
    const measurement = await measureTree(tree, measureOptions);
    cacheStats.parsed += measurement.stats.parsed;
    cacheStats.cached += measurement.stats.cached;
    const records = new Map(measurement.files.map((file) => [file.path, file] as const));
    for (const { path, blob } of wanted) {
      const record = records.get(path);
      if (record !== undefined && record.source !== null) parents.set(pairKey(path, blob), record);
    }
  }
  /** The units of a revision that its parent revision has no counterpart for, by the same matcher that follows units forward. */
  const createdBy = (touch: Touch, record: FileRecord): ReadonlySet<string> => {
    const parent = touch.oldBlob === undefined ? undefined : parents.get(pairKey(touch.path, touch.oldBlob));
    if (parent === undefined) return new Set();
    const existed = new Set(followUnits(parent, parent.units, record, record.units, settings.moveSimilarity, bodyCache).flatMap((match) => (match.after === undefined ? [] : [match.after.id])));
    return new Set(record.units.map((unit) => unit.id).filter((id) => !existed.has(id)));
  };

  /** Which unit a historical unit is now, by revision of a file: `c:` is a unit that still exists and `d:` one that does not. */
  const mapping = new Map<string, Map<string, string>>();
  const retained = new Map<string, { record: FileRecord; unmatched: UnitRecord[] }>();
  const unitTouches: { key: string; unitId: string; changeId: string; sha: string; fix: boolean; review: boolean }[] = [];
  const outsideTouches: { fileId: string; changeId: string; fix: boolean }[] = [];
  let analysedFiles = 0;

  const layers = Math.max(0, ...[...blobsByPath.values()].map((blobs) => blobs.length));
  for (let layer = 0; layer < layers; layer++) {
    const wanted = [...blobsByPath].flatMap(([path, blobs]) => (blobs[layer] === undefined ? [] : [{ path, blob: blobs[layer]! }]));
    const texts = await readBlobs(root, wanted.map((entry) => entry.blob));
    const tree = treeFromTexts(Object.fromEntries(wanted.flatMap((entry) => (texts.has(entry.blob) ? [[entry.path, texts.get(entry.blob)!]] : []))));
    const measurement = await measureTree(tree, measureOptions);
    cacheStats.parsed += measurement.stats.parsed;
    cacheStats.cached += measurement.stats.cached;
    for (const reason of ["binary", "large", "excluded", "tests"] as const) skipped[reason] += measurement.skippedFiles[reason];
    const records = new Map(measurement.files.map((file) => [file.path, file] as const));

    for (const { path, blob } of wanted) {
      const record = records.get(path);
      if (record === undefined) continue;
      const key = pairKey(path, blob);
      const pairTouches = touchesByPair.get(key) ?? [];
      if (record.source === null) {
        skipped.noAdapter += pairTouches.length;
        continue;
      }
      analysedFiles += pairTouches.length;
      const fileId = fileOfPair.get(key)!;
      const target = currentFiles.get(fileId);
      const map = new Map<string, string>();
      const unmatched: UnitRecord[] = [];
      if (target === undefined) unmatched.push(...record.units);
      else {
        for (const { before, after } of followUnits(record, record.units, target, target.units, settings.moveSimilarity, bodyCache)) {
          if (after === undefined) unmatched.push(before);
          else map.set(before.id, `c:${after.id}`);
        }
      }
      mapping.set(key, map);
      if (unmatched.length > 0) retained.set(key, { record, unmatched });

      for (const touch of pairTouches) {
        if (touch.added) {
          for (const unit of record.units) unitTouches.push({ key, unitId: unit.id, changeId: touch.changeId, sha: touch.sha, fix: false, review: false });
          continue;
        }
        const fix = (fixOf.get(touch.changeId) ?? null) !== null;
        const hit = touchedUnits(record.units, touch.ranges);
        const created = isFixLike(touch) ? createdBy(touch, record) : new Set<string>();
        for (const unitId of hit.units) {
          const isNew = created.has(unitId);
          unitTouches.push({ key, unitId, changeId: touch.changeId, sha: touch.sha, fix: fix && !isNew, review: !isNew && reviewFixOf.has(touch.sha) });
        }
        if (hit.outsideUnits) outsideTouches.push({ fileId, changeId: touch.changeId, fix });
      }
    }
  }

  // A unit that is gone follows its later self in the file's latest analysed revision, so a rename before its deletion keeps its history.
  for (const [key, entry] of retained) {
    const latest = latestPair.get(fileOfPair.get(key)!);
    const later = latest === undefined || latest === key ? undefined : retained.get(latest);
    if (later === undefined) continue;
    const map = mapping.get(key)!;
    for (const { before, after } of followUnits(entry.record, entry.unmatched, later.record, later.unmatched, settings.moveSimilarity, bodyCache)) {
      if (after !== undefined) map.set(before.id, `d:${after.id}`);
    }
  }

  const aggregates = new Map<string, Aggregate>();
  for (const touch of unitTouches) {
    const key = mapping.get(touch.key)?.get(touch.unitId) ?? `d:${touch.unitId}`;
    const entry = aggregates.get(key) ?? { changes: new Set<string>(), fixes: new Set<string>(), review: new Set<string>(), ids: new Set<string>() };
    aggregates.set(key, entry);
    entry.changes.add(touch.changeId);
    if (touch.fix) entry.fixes.add(touch.changeId);
    if (touch.review) entry.review.add(touch.sha);
    entry.ids.add(touch.unitId);
  }

  const build = (key: string, entry: Aggregate): UnitFixes => {
    const id = key.slice(2);
    const newestFirst = [...entry.fixes].sort((a, b) => landedById.get(b)!.time - landedById.get(a)!.time || utf8(a, b));
    const kept = fixEvidence(newestFirst.map((changeId) => fixOf.get(changeId)!), request.evidence);
    const dateOf = new Map(newestFirst.map((changeId) => [fixOf.get(changeId)!.id, landedById.get(changeId)!.time] as const));
    const reviewNewest = [...entry.review].sort((a, b) => commitBySha.get(b)!.committerDate - commitBySha.get(a)!.committerDate || utf8(a, b));
    const reviewKept = fixEvidence(reviewNewest.map((sha) => reviewFixOf.get(sha)!), request.evidence);
    const unit = key.startsWith("c:") ? currentUnits.get(id) : undefined;
    return {
      id,
      path: unit?.path ?? id.slice(0, id.indexOf("#")),
      current: unit,
      fixCommits: entry.fixes.size,
      revisions: entry.changes.size,
      fixShare: entry.changes.size === 0 ? null : round3(entry.fixes.size / entry.changes.size),
      evidence: kept.commits.map((match) => ({ sha: match.id, date: day(dateOf.get(match.id)!), subject: match.subject, pattern: match.pattern, matchedIn: match.matchedIn })),
      evidenceOmitted: kept.omitted,
      reviewFixes: entry.review.size,
      reviewEvidence: reviewKept.commits.map((match) => ({ sha: match.id, date: day(commitBySha.get(match.id)!.committerDate), subject: match.subject, pattern: match.pattern, matchedIn: match.matchedIn })),
      reviewEvidenceOmitted: reviewKept.omitted,
      earlierIds: [...entry.ids].filter((earlier) => earlier !== id).sort(utf8),
    };
  };
  const units = new Map<string, UnitFixes>();
  const changes = new Map<string, ReadonlySet<string>>();
  const deleted: UnitFixes[] = [];
  for (const [key, entry] of aggregates) {
    const row = build(key, entry);
    if (key.startsWith("c:")) {
      units.set(row.id, row);
      changes.set(row.id, entry.changes);
    } else deleted.push(row);
  }
  deleted.sort(byFixes(settings.fixes.minRevisions));

  const outsideByFile = new Map<string, { changes: Set<string>; fixes: Set<string> }>();
  for (const touch of outsideTouches) {
    const entry = outsideByFile.get(touch.fileId) ?? { changes: new Set<string>(), fixes: new Set<string>() };
    outsideByFile.set(touch.fileId, entry);
    entry.changes.add(touch.changeId);
    if (touch.fix) entry.fixes.add(touch.changeId);
  }
  const outsideFiles = [...outsideByFile]
    .map(([path, entry]): OutsideUnits => ({ path, fixCommits: entry.fixes.size, revisions: entry.changes.size }))
    .filter((file) => file.fixCommits > 0)
    .sort((a, b) => b.fixCommits - a.fixCommits || utf8(a.path, b.path));

  const all = [...units.values(), ...deleted];
  return {
    window,
    convention,
    excluded: fixEvidence(excludedMatches),
    minRevisions: settings.fixes.minRevisions,
    shallow,
    commits,
    files: { analysed: analysedFiles, skipped },
    cache: cacheStats,
    units,
    changes,
    deleted,
    outside: {
      fixCommits: new Set(outsideTouches.filter((touch) => touch.fix).map((touch) => touch.changeId)).size,
      fixFileChanges: outsideFiles.reduce((sum, file) => sum + file.fixCommits, 0),
      files: outsideFiles,
    },
    unitsTouched: all.length,
    unitsWithFixes: all.filter((unit) => unit.fixCommits > 0).length,
  };
}
