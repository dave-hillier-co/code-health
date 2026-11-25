import { runGit } from "@code-health/history/git";
import type { Commit } from "@code-health/history/trend-samples";
import type { GrammarSet } from "@code-health/parse/grammars";
import { adapterForPath } from "@code-health/parse/languages";
import type { ParseCache } from "@code-health/parse/parse-cache";
import { readBlobs, treeFromTexts } from "@code-health/parse/source-tree";
import type { ComplexitySettings } from "./config.ts";
import { parseDiffs, touchedUnits, type FileDiff } from "./fix-ranges.ts";
import { followUnits, type BodyCache } from "./match-units.ts";
import { measureTree, type FileRecord, type UnitRecord } from "./measure.ts";
import { topLevelUnits } from "./rows.ts";

/** First-parent commits diffed and measured together, so that the texts held at once stay bounded. */
const CHUNK = 200;

/** The functions a backtest follows in one revision of a file: its top-level production functions with a cyclomatic complexity. */
export function followedUnits(file: FileRecord): UnitRecord[] {
  if (file.test) return [];
  return topLevelUnits(file.units).filter((unit) => !unit.test && unit.values.cyclomatic !== undefined);
}

/** One landed change that changed lines of a function. */
export interface FunctionTouch {
  /** Index of the change's commit on the first-parent line. */
  at: number;
  /** Lines added inside the function, and its share of the deleted lines of the hunks that touched it. */
  churn: number;
  /** The change created the function: it had no counterpart in the revision before. */
  created: boolean;
}

interface Tracked {
  record: FileRecord;
  /** The lineage of each followed function, by its id in `record`. */
  lineage: Map<string, string>;
}

const pairKey = (path: string, blob: string): string => `${path}\0${blob}`;

/**
 * Follows functions along the first-parent line, one commit to the next, as `complexity fixes` follows them: each revision of
 * a file is diffed against the one before it on the line, the changed lines are mapped onto the functions that hold them, and
 * the functions of the two revisions are paired by identity, then by body similarity (`complexity.moveSimilarity`). A file is
 * followed through the renames git detects. Each function has a lineage that stays the same while it is followed, and ends
 * when a later revision has no counterpart for it.
 *
 * A file no commit has touched since the start is not read: its functions get a lineage from their path and name, which the
 * first commit that touches the file takes up.
 */
export class FunctionFollower {
  /** Index on the line of the last commit followed. */
  private position: number;
  private readonly state = new Map<string, Tracked>();
  /** The path a file had at the start, by its path now, for files renamed without a change and not read since. */
  private readonly origin = new Map<string, string>();
  readonly touches = new Map<string, FunctionTouch[]>();
  /** Index on the line of the commit at which each lineage that ended was last seen. */
  readonly ended = new Map<string, number>();
  readonly stats = { parsed: 0, cached: 0 };

  constructor(
    private readonly root: string,
    private readonly settings: ComplexitySettings,
    private readonly line: readonly Commit[],
    start: number,
    private readonly measure: { cache: ParseCache; grammars: GrammarSet },
  ) {
    this.position = start;
  }

  /** The lineage of a function of the revision the follower has reached, or undefined when the follower lost track of it. */
  lineageOf(path: string, unitId: string): string | undefined {
    const tracked = this.state.get(path);
    if (tracked !== undefined) return tracked.lineage.get(unitId);
    return `${this.origin.get(path) ?? path}${unitId.slice(path.length)}`;
  }

  /** Follows every commit of the line after the one reached, up to and including the one at `index`. */
  async advanceTo(index: number): Promise<void> {
    while (this.position < index) {
      const first = this.position + 1;
      const last = Math.min(index, this.position + CHUNK);
      await this.follow(first, last);
      this.position = last;
    }
  }

  private analysable(path: string): boolean {
    return adapterForPath(path) !== undefined && !this.settings.isExcluded(path) && !this.settings.isTest(path);
  }

  private async follow(first: number, last: number): Promise<void> {
    const input = [];
    for (let k = first; k <= last; k++) input.push(k === 0 ? this.line[k]!.sha : `${this.line[k]!.sha} ${this.line[k - 1]!.sha}`);
    const out = await runGit(this.root, ["-c", "core.quotePath=false", "diff-tree", "--stdin", "-p", "-U0", "-M", "--no-color", "--no-ext-diff", "--full-index", "--root", "-r"], { input: `${input.join("\n")}\n` });
    const diffs = parseDiffs(out);
    const commits: { at: number; files: [string, FileDiff][] }[] = [];
    for (let k = first; k <= last; k++) commits.push({ at: k, files: [...(diffs.get(this.line[k]!.sha) ?? new Map<string, FileDiff>())] });

    // Which revisions to read: each new revision of a source file, and the one before for a file not read since the start.
    const known = new Set(this.state.keys());
    const wanted = new Map<string, string[]>();
    const want = (path: string, blob: string) => {
      const blobs = wanted.get(path) ?? [];
      if (!blobs.includes(blob)) blobs.push(blob);
      wanted.set(path, blobs);
    };
    for (const { files } of commits) {
      for (const [path, diff] of files) {
        const earlier = diff.oldPath ?? path;
        if (diff.deleted) {
          known.delete(earlier);
          continue;
        }
        if (diff.newBlob === undefined) {
          if (known.delete(earlier)) known.add(path);
          continue;
        }
        if (!diff.added && !known.has(earlier) && diff.oldBlob !== undefined && this.analysable(earlier)) want(earlier, diff.oldBlob);
        known.delete(earlier);
        if (this.analysable(path)) {
          want(path, diff.newBlob);
          known.add(path);
        }
      }
    }

    const records = new Map<string, FileRecord>();
    const layers = Math.max(0, ...[...wanted.values()].map((blobs) => blobs.length));
    for (let layer = 0; layer < layers; layer++) {
      const pairs = [...wanted].flatMap(([path, blobs]) => (blobs[layer] === undefined ? [] : [{ path, blob: blobs[layer]! }]));
      const texts = await readBlobs(this.root, pairs.map((pair) => pair.blob));
      const tree = treeFromTexts(Object.fromEntries(pairs.flatMap((pair) => (texts.has(pair.blob) ? [[pair.path, texts.get(pair.blob)!]] : []))));
      const measurement = await measureTree(tree, { settings: this.settings, layer: "structural", cache: this.measure.cache, keepText: true, grammars: this.measure.grammars });
      this.stats.parsed += measurement.stats.parsed;
      this.stats.cached += measurement.stats.cached;
      const byPath = new Map(measurement.files.map((file) => [file.path, file] as const));
      for (const pair of pairs) {
        const record = byPath.get(pair.path);
        if (record !== undefined) records.set(pairKey(pair.path, pair.blob), record);
      }
    }

    const bodies: BodyCache = new Map();
    for (const { at, files } of commits) for (const [path, diff] of files) this.apply(at, path, diff, records, bodies);
  }

  private end(tracked: Tracked | undefined, at: number): void {
    for (const lineage of tracked?.lineage.values() ?? []) this.ended.set(lineage, at);
  }

  private fromStart(path: string, record: FileRecord): Tracked {
    const origin = this.origin.get(path) ?? path;
    return { record, lineage: new Map(followedUnits(record).map((unit) => [unit.id, `${origin}${unit.id.slice(path.length)}`] as const)) };
  }

  private apply(at: number, path: string, diff: FileDiff, records: ReadonlyMap<string, FileRecord>, bodies: BodyCache): void {
    const earlierPath = diff.oldPath ?? path;
    if (diff.deleted) {
      this.end(this.state.get(earlierPath), at);
      this.state.delete(earlierPath);
      this.origin.delete(earlierPath);
      return;
    }
    if (diff.newBlob === undefined) {
      // A rename that changed nothing in the file, or a change of mode.
      if (earlierPath === path) return;
      const tracked = this.state.get(earlierPath);
      this.state.delete(earlierPath);
      if (tracked === undefined) this.origin.set(path, this.origin.get(earlierPath) ?? earlierPath);
      else {
        const relocate = (id: string) => `${path}${id.slice(earlierPath.length)}`;
        const record = { ...tracked.record, path, units: tracked.record.units.map((unit) => ({ ...unit, path, id: relocate(unit.id) })) };
        this.state.set(path, { record, lineage: new Map([...tracked.lineage].map(([id, lineage]) => [relocate(id), lineage] as const)) });
      }
      this.origin.delete(earlierPath);
      return;
    }

    let earlier: Tracked | undefined;
    if (!diff.added) {
      earlier = this.state.get(earlierPath);
      if (earlier === undefined && diff.oldBlob !== undefined) {
        const record = records.get(pairKey(earlierPath, diff.oldBlob));
        if (record !== undefined) earlier = this.fromStart(earlierPath, record);
      }
    }
    this.state.delete(earlierPath);
    this.origin.delete(earlierPath);
    this.origin.delete(path);
    const later = records.get(pairKey(path, diff.newBlob));
    if (later === undefined) {
      this.end(earlier, at);
      return;
    }

    const units = followedUnits(later);
    const lineage = new Map<string, string>();
    const created = new Set<string>();
    if (earlier !== undefined) {
      for (const { before, after } of followUnits(earlier.record, followedUnits(earlier.record), later, units, this.settings.moveSimilarity, bodies)) {
        const own = earlier.lineage.get(before.id);
        if (own === undefined) continue;
        if (after === undefined) this.ended.set(own, at);
        else lineage.set(after.id, own);
      }
    }
    for (const unit of units) {
      if (lineage.has(unit.id)) continue;
      lineage.set(unit.id, `${at}:${unit.id}`);
      created.add(unit.id);
    }
    this.state.set(path, { record: later, lineage });

    const churn = new Map<string, number>();
    for (const range of diff.ranges) {
      const hit = touchedUnits(units, [range]).units;
      if (hit.size === 0) continue;
      const last = range.start + range.count - 1;
      for (const unit of units) {
        if (!hit.has(unit.id)) continue;
        const added = Math.max(0, Math.min(last, unit.endLine) - Math.max(range.start, unit.startLine) + 1);
        churn.set(unit.id, (churn.get(unit.id) ?? 0) + added + (range.removed ?? 0) / hit.size);
      }
    }
    for (const [unitId, lines] of churn) {
      const own = lineage.get(unitId)!;
      const list = this.touches.get(own) ?? [];
      list.push({ at, churn: lines, created: created.has(unitId) });
      this.touches.set(own, list);
    }
  }
}
