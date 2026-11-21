/** One line of a unified diff hunk: added, removed, or context. */
export interface HunkLine {
  kind: "+" | "-" | " ";
  /** The line without its diff marker. */
  text: string;
}

export interface Hunk {
  lines: HunkLine[];
}

/**
 * The hunks of the unified diff of one file, with their context lines. Everything before the first
 * `@@` (the `diff --git`, `index`, `---` and `+++` header) is ignored, and so are "No newline" markers.
 */
export function parseUnifiedHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      current = { lines: [] };
      hunks.push(current);
    } else if (line.startsWith("diff --git ")) {
      current = undefined;
    } else if (current !== undefined && (line[0] === "+" || line[0] === "-" || line[0] === " ")) {
      current.lines.push({ kind: line[0], text: line.slice(1) });
    }
  }
  return hunks;
}

export interface AppendShapeOptions {
  /** The most non-blank lines a hunk may change and still be an entry added or removed. */
  maxLines?: number;
  /** The lowest Dice coefficient over the bigrams of two lines' shapes for them to count as alike. */
  minSimilarity?: number;
}

export const DEFAULT_MAX_APPEND_LINES = 5;
export const DEFAULT_MIN_LINE_SIMILARITY = 0.7;

const indentOf = (text: string): string => text.slice(0, text.length - text.trimStart().length);
const isBlank = (text: string): boolean => text.trim() === "";
const OPENER = /[[{(]$/;
const CLOSER = /^[\]})]/;

/**
 * A line with its strings, numbers and names replaced by placeholders and its whitespace removed, so
 * `{ path: "/a", component: A },` and `{ path: "/b", component: B },` have the same shape.
 */
export function lineShape(text: string): string {
  return text
    .trim()
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, "S")
    .replace(/\b\d+(?:\.\d+)?\b/g, "N")
    .replace(/[A-Za-z_$][\w$]*/g, "I")
    .replace(/\s+/g, "");
}

function bigrams(shape: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i + 1 < shape.length; i++) {
    const pair = shape.slice(i, i + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/** Dice coefficient over the bigrams of two lines' shapes: 1 for the same shape, near 0 for unrelated lines. */
export function lineSimilarity(a: string, b: string): number {
  const shapeA = lineShape(a);
  const shapeB = lineShape(b);
  if (shapeA === shapeB) return 1;
  const left = bigrams(shapeA);
  const right = bigrams(shapeB);
  let common = 0;
  let total = 0;
  for (const count of left.values()) total += count;
  for (const count of right.values()) total += count;
  for (const [pair, count] of left) common += Math.min(count, right.get(pair) ?? 0);
  return total === 0 ? 0 : (2 * common) / total;
}

/**
 * Whether a hunk adds entries to, or removes entries from, one collection, found without a parser:
 *
 * - it only adds lines, or only removes them, a few at most;
 * - every changed line sits at the same indentation;
 * - the lines next to the change (its context) are siblings at that indentation, or the bracket that
 *   opens the block before it or closes the block after it, and never a deeper block;
 * - each changed line is lexically similar to a sibling next to it or to another changed line, which
 *   tells an entry in a list from a statement in a body.
 *
 * With no sibling to compare against, only entries that end in a comma between the brackets count. A
 * hunk needs context to be placed in a block, so a diff made without it is never an append.
 */
export function appendShape(hunk: Hunk, options: AppendShapeOptions = {}): "addition" | "removal" | null {
  // Changes a few lines apart share one hunk, so each run of changed lines is judged on its own,
  // beside the context around it, and the hunk is an append only if every run is.
  const shapes = new Set<"addition" | "removal" | null>();
  let start = 0;
  while (start < hunk.lines.length) {
    if (hunk.lines[start]!.kind === " ") {
      start++;
      continue;
    }
    let end = start;
    while (end + 1 < hunk.lines.length && hunk.lines[end + 1]!.kind !== " ") end++;
    shapes.add(runShape(hunk, start, end, options));
    start = end + 1;
  }
  const [only] = shapes;
  return shapes.size === 1 ? (only ?? null) : null;
}

function runShape(hunk: Hunk, first: number, last: number, options: AppendShapeOptions): "addition" | "removal" | null {
  const maxLines = options.maxLines ?? DEFAULT_MAX_APPEND_LINES;
  const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_LINE_SIMILARITY;

  const changed = hunk.lines.slice(first, last + 1);
  const kinds = new Set(changed.map((line) => line.kind));
  if (kinds.size !== 1) return null;
  const entries = changed.filter((line) => !isBlank(line.text));
  if (entries.length === 0 || entries.length > maxLines) return null;
  const indentation = indentOf(entries[0]!.text);
  if (entries.some((line) => indentOf(line.text) !== indentation)) return null;

  // the nearest line that is not blank counts, and only if it is context: another run is not a neighbour
  const nearest = hunk.lines.slice(0, first).reverse().find((line) => !isBlank(line.text));
  const before = nearest?.kind === " " ? nearest : undefined;
  const next = hunk.lines.slice(last + 1).find((line) => !isBlank(line.text));
  const after = next?.kind === " " ? next : undefined;
  if (before === undefined && after === undefined) return null;

  const siblings: string[] = [];
  let opened = false;
  let closed = false;
  for (const [neighbour, side] of [[before, "before"], [after, "after"]] as const) {
    if (neighbour === undefined) continue;
    const text = neighbour.text;
    const level = indentOf(text);
    if (level === indentation) {
      siblings.push(text);
    } else if (level.length < indentation.length && side === "before" && OPENER.test(text.trimEnd())) {
      opened = true;
    } else if (level.length < indentation.length && side === "after" && CLOSER.test(text.trimStart())) {
      closed = true;
    } else {
      return null;
    }
  }

  const alike = (line: HunkLine) =>
    siblings.some((sibling) => lineSimilarity(line.text, sibling) >= minSimilarity) ||
    entries.some((other) => other !== line && lineSimilarity(line.text, other.text) >= minSimilarity);
  if (siblings.length > 0 ? !entries.every(alike) : !(opened && closed && entries.every((line) => line.text.trimEnd().endsWith(",")))) {
    return null;
  }
  return kinds.has("+") ? "addition" : "removal";
}

/**
 * The line that opens the block an entry sits in: the nearest line above its first occurrence in
 * `lines` that is indented less. Lines are numbered from 1. Undefined when the entry is not in the
 * text or sits at the top level.
 */
export function collectionOpener(lines: readonly string[], entry: string): { line: number; text: string } | undefined {
  const wanted = entry.trim();
  if (wanted === "") return undefined;
  const index = lines.findIndex((line) => line.trim() === wanted);
  if (index < 0) return undefined;
  const indentation = indentOf(lines[index]!).length;
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!isBlank(line) && indentOf(line).length < indentation) return { line: i + 1, text: line.trim() };
  }
  return undefined;
}
