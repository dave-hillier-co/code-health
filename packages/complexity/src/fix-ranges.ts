import type { UnitRecord } from "./measure.ts";

/** Lines a commit changed in the new revision of one file. `count` 0 is a deletion between line `start` and the next. */
export interface ChangedRange {
  start: number;
  count: number;
}

/** What `git diff-tree -p -U0` says one commit did to one file, by the file's new path. */
export interface FileDiff {
  /** The commit created the file, so every line is new and there is no earlier revision to have fixed. */
  added: boolean;
  ranges: ChangedRange[];
}

const COMMIT_LINE = /^[0-9a-f]{40}$/;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses the output of `git diff-tree --stdin -p -U0 -M`: for each commit a line with its id, then a diff against
 * its first parent. A path git quotes (a name with a quote, backslash or control character) is left out, so its changes
 * count for nothing, and a deleted file has no new revision to map.
 */
export function parseDiffs(output: string): Map<string, Map<string, FileDiff>> {
  const commits = new Map<string, Map<string, FileDiff>>();
  let files: Map<string, FileDiff> | undefined;
  let file: FileDiff | undefined;
  let added = false;
  for (const line of output.split("\n")) {
    if (COMMIT_LINE.test(line)) {
      files = new Map();
      commits.set(line, files);
      file = undefined;
    } else if (line.startsWith("diff --git ")) {
      file = undefined;
      added = false;
    } else if (line.startsWith("new file mode")) {
      added = true;
    } else if (line.startsWith("+++ ")) {
      const target = line.slice(4).replace(/\t$/, "");
      file = undefined;
      if (files !== undefined && target.startsWith("b/")) {
        file = { added, ranges: [] };
        files.set(target.slice(2), file);
      }
    } else if (file !== undefined) {
      const hunk = HUNK.exec(line);
      if (hunk !== null) file.ranges.push({ start: Number(hunk[1]), count: hunk[2] === undefined ? 1 : Number(hunk[2]) });
    }
  }
  return commits;
}

interface Interval {
  from: number;
  to: number;
}

/** The lines a range covers. A deletion covers the two lines it sits between, so one inside a function is that function's. */
function interval(range: ChangedRange): Interval {
  return range.count === 0 ? { from: range.start, to: range.start + 1 } : { from: range.start, to: range.start + range.count - 1 };
}

/** What is left of `from..to` once the intervals are taken out. */
function without(span: Interval, taken: readonly Interval[]): Interval[] {
  let rest = [span];
  for (const cut of taken) {
    rest = rest.flatMap((part) => {
      if (cut.to < part.from || cut.from > part.to) return [part];
      const pieces: Interval[] = [];
      if (cut.from > part.from) pieces.push({ from: part.from, to: cut.from - 1 });
      if (cut.to < part.to) pieces.push({ from: cut.to + 1, to: part.to });
      return pieces;
    });
  }
  return rest;
}

export interface Touches {
  /** Ids of the units with a changed line of their own, that is a line inside them and not inside a unit nested in them. */
  units: Set<string>;
  /** A changed line sits outside every unit, so the change counts against the file. */
  outsideUnits: boolean;
}

/**
 * Maps changed line ranges onto the functions and methods that contain them. A function nested in another owns its lines,
 * and the function around it owns the rest, so one edit is never counted for both. A deletion between two lines counts for
 * the unit that holds both.
 */
export function touchedUnits(units: readonly UnitRecord[], ranges: readonly ChangedRange[]): Touches {
  const touched = new Set<string>();
  let outsideUnits = false;
  const spans = units.map((unit) => ({ unit, from: unit.startLine, to: unit.endLine }));
  for (const range of ranges) {
    const changed = interval(range);
    // A deletion belongs to a unit that holds both lines it sits between. Any other range belongs to every unit it overlaps.
    const inside = spans.filter((span) => (range.count === 0 ? span.from <= changed.from && changed.to <= span.to : span.from <= changed.to && changed.from <= span.to));
    for (const span of inside) {
      const nested = inside.filter((other) => other !== span && span.from <= other.from && other.to <= span.to && (span.from < other.from || other.to < span.to));
      const own = without({ from: Math.max(span.from, changed.from), to: Math.min(span.to, changed.to) }, nested);
      if (own.length > 0) touched.add(span.unit.id);
    }
    const outside = range.count === 0 ? inside.length === 0 : without(changed, inside.map((span) => ({ from: span.from, to: span.to }))).length > 0;
    if (outside) outsideUnits = true;
  }
  return { units: touched, outsideUnits };
}
