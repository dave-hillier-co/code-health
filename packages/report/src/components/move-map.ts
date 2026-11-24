import { escapeHtml, escapeMd, formatNumber } from "../text.ts";
import { htmlTable, mdTable, type TableColumn } from "../tables.ts";
import { figureHtml } from "./figure.ts";

/** A kind of arrow or marker. It is named in the legend and styled through its class. */
export interface MoveMapKind {
  kind: string;
  /** The words the row text and the legend use, such as "move" or "blocked move". */
  word: string;
  /** What the kind means, one sentence for the legend. */
  meaning: string;
  /** Arrows of this kind are drawn dashed. The row text and the legend also say the word, so the dash is not the only signal. */
  dashed?: boolean;
}

/** An arrow from the folder a unit is in to the folder it would move to. */
export interface MoveMapEdge {
  /** The number printed on the arrow, such as "3" or "B1". */
  label: string;
  from: string;
  to: string;
  kind: string;
  /** Sets the line thickness. */
  value: number;
  /** Printed after the arrow's label in the row text. Without it the row prints `<valueLabel> <value>`. */
  valueText?: string;
  /** Printed in the row text after the value, such as the blocker of a blocked move. */
  note?: string;
}

/** A marker on a folder, for a unit with no single target. */
export interface MoveMapMark {
  folder: string;
  label: string;
  kind: string;
  /** Printed in the row text after the label, such as the blocker of a blocked unit. */
  note?: string;
}

export interface MoveMapData {
  title: string;
  /** What an arrow's value measures, such as "gain". */
  valueLabel: string;
  /** Folder paths (posix, "" for the repository root) that are drawn besides the folders of the arrows and markers. Their ancestors are drawn to connect them. */
  folders: string[];
  /** How the root folder reads in the tree. */
  rootText: string;
  edges: MoveMapEdge[];
  marks: MoveMapMark[];
  kinds: MoveMapKind[];
  /** The text table of the same data, one row per arrow and marker. */
  table: { columns: TableColumn[]; rows: string[][] };
  /** Says what the drawing leaves out and why. */
  omitted?: string;
}

interface TreeRow {
  /** The folder path of the row. */
  path: string;
  label: string;
  depth: number;
}

const ROW = 22;
const LINE = 13;
const INDENT = 14;
const CHAR = 6.2;
const MARGIN = 8;
const LANE = 12;
const GUTTER = 18;
const THIN = 1.5;
const THICK = 4.5;

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** The tree of the folders and their ancestors as indented rows. A folder that is not listed and has one child joins its child's label, so `src/a/b` is one row. */
export function treeRows(folders: readonly string[], rootText: string): TreeRow[] {
  const chosen = new Set(folders);
  const nodes = new Set<string>();
  for (const folder of folders) {
    for (let path = folder; ; path = parentOf(path)) {
      nodes.add(path);
      if (path === "") break;
    }
  }
  const children = new Map<string, string[]>();
  for (const path of [...nodes].filter((p) => p !== "").sort()) children.set(parentOf(path), [...(children.get(parentOf(path)) ?? []), path]);
  const rows: TreeRow[] = [];
  const emit = (start: string, shownParent: string, depth: number) => {
    let path = start;
    while (!chosen.has(path) && (children.get(path) ?? []).length === 1) path = children.get(path)![0]!;
    rows.push({ path, label: shownParent === "" ? path : path.slice(shownParent.length + 1), depth });
    for (const child of children.get(path) ?? []) emit(child, path, depth + 1);
  };
  if (chosen.has("")) {
    rows.push({ path: "", label: rootText, depth: 0 });
    for (const child of children.get("") ?? []) emit(child, "", 1);
  } else {
    for (const child of children.get("") ?? []) emit(child, "", 0);
  }
  return rows;
}

/** Assigns each span the first lane whose earlier spans do not overlap it. */
function lanesFor(spans: readonly [number, number][]): number[] {
  const taken: [number, number][][] = [];
  return spans.map(([a, b]) => {
    const lane = taken.findIndex((used) => used.every(([c, d]) => b < c || a > d));
    const at = lane === -1 ? taken.length : lane;
    taken[at] = [...(taken[at] ?? []), [a, b]];
    return at;
  });
}

/** The lines of text at the right of each row: the arrows that start and end there, then the markers, grouped by kind. */
function rowTexts(data: MoveMapData, rows: readonly TreeRow[]): string[][] {
  const word = (kind: string) => data.kinds.find((k) => k.kind === kind)?.word ?? kind;
  return rows.map((row) => {
    const parts: string[] = [];
    for (const edge of data.edges.filter((e) => e.from === row.path)) {
      const value = edge.valueText ?? `${data.valueLabel} ${formatNumber(edge.value)}`;
      parts.push(`${word(edge.kind)} ${edge.label} out: ${value}${edge.note === undefined ? "" : `, ${edge.note}`}`);
    }
    for (const edge of data.edges.filter((e) => e.to === row.path)) parts.push(`${word(edge.kind)} ${edge.label} in`);
    const kinds = [...new Set(data.marks.filter((m) => m.folder === row.path).map((m) => m.kind))];
    for (const kind of kinds) parts.push(`${word(kind)} ${data.marks.filter((m) => m.folder === row.path && m.kind === kind).map((m) => `${m.label}${m.note === undefined ? "" : ` (${m.note})`}`).join(", ")}`);
    return parts;
  });
}

function legendLines(data: MoveMapData): string[] {
  const kindLines = data.kinds.map((k) => `${k.word}${k.dashed === true ? " (dashed line)" : ""}: ${k.meaning}`);
  const lines = [
    "Each folder is a row, indented under its parent. A folder with nothing of its own and one child is joined to that child.",
    `An arrow runs from the folder a unit is in to the folder it moves to. Its number is the unit's number in the table, its thickness grows with ${data.valueLabel}, and the row text prints the number and ${data.valueLabel}. A solid line and a dashed line are told apart by the word in the row text as well as by the dash.`,
    ...kindLines,
  ];
  if (data.omitted !== undefined) lines.push(data.omitted);
  return lines;
}

const tableCaption = (data: MoveMapData) => `${data.title}: each arrow and marker`;

export function moveMapHtml(data: MoveMapData): string {
  const rows = treeRows([...new Set([...data.folders, ...data.edges.flatMap((e) => [e.from, e.to]), ...data.marks.map((m) => m.folder)])], data.rootText);
  const index = new Map(rows.map((row, i) => [row.path, i]));
  const texts = rowTexts(data, rows);
  const heights = texts.map((lines) => Math.max(ROW, lines.length * LINE + 9));
  const tops = heights.map((_, i) => heights.slice(0, i).reduce((sum, h) => sum + h, 0));
  const treeRight = Math.max(...rows.map((row) => MARGIN + row.depth * INDENT + row.label.length * CHAR), 0) + 10;
  const edges = data.edges.flatMap((edge) => {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    return from === undefined || to === undefined ? [] : [{ edge, from, to }];
  });
  const lanes = lanesFor(edges.map(({ from, to }) => [Math.min(from, to), Math.max(from, to)]));
  const laneCount = lanes.reduce((most, lane) => Math.max(most, lane + 1), 0);
  const textX = treeRight + GUTTER + laneCount * LANE + GUTTER;
  // Each end of an arrow on a row gets its own height, so ends on one row do not overlap.
  const ends = new Map<number, number>();
  for (const { from, to } of edges) for (const row of [from, to]) ends.set(row, (ends.get(row) ?? 0) + 1);
  const used = new Map<number, number>();
  const endY = (row: number) => {
    const count = ends.get(row) ?? 1;
    const k = used.get(row) ?? 0;
    used.set(row, k + 1);
    const step = Math.min(4, (heights[row]! - 8) / Math.max(1, count - 1));
    return tops[row]! + heights[row]! / 2 + (k - (count - 1) / 2) * step;
  };
  const greatest = Math.max(1, ...edges.map(({ edge }) => edge.value));
  const kindOf = (kind: string) => data.kinds.find((k) => k.kind === kind);
  const lines = rows.map((row, i) => {
    const y = tops[i]! + 15;
    const x = MARGIN + row.depth * INDENT;
    const guide = `<line class="guide" x1="${(x + row.label.length * CHAR).toFixed(1)}" y1="${y - 4}" x2="${treeRight.toFixed(1)}" y2="${y - 4}"/>`;
    const notes = texts[i]!.map((text, k) => `<text class="row-note" x="${textX.toFixed(1)}" y="${y + k * LINE}">${escapeHtml(text)}</text>`).join("");
    return `<g class="folder-row"><text class="folder-name" x="${x}" y="${y}">${escapeHtml(row.label)}</text>${guide}${notes}</g>`;
  });
  const arrows = edges.map(({ edge, from, to }, i) => {
    const x = treeRight + GUTTER + lanes[i]! * LANE;
    const y1 = endY(from);
    const y2 = endY(to);
    const width = THIN + ((edge.value / greatest) * (THICK - THIN));
    const style = kindOf(edge.kind)?.dashed === true ? "dashed" : "solid";
    const tip = treeRight + 1;
    return `<g class="edge ${escapeHtml(edge.kind)} ${style}"><path d="M${tip + 4} ${y1.toFixed(1)}H${x}V${y2.toFixed(1)}H${tip + 5}" stroke-width="${width.toFixed(1)}"/><polygon points="${tip},${y2.toFixed(1)} ${tip + 7},${(y2 - 3.5).toFixed(1)} ${tip + 7},${(y2 + 3.5).toFixed(1)}"/><title>${escapeHtml(`${edge.label}: ${edge.from === "" ? data.rootText : edge.from} to ${edge.to === "" ? data.rootText : edge.to}`)}</title></g>`;
  });
  const widest = Math.max(0, ...texts.flat().map((t) => t.length)) * CHAR;
  const kindText = data.kinds.map((k) => `${k.word}${k.dashed === true ? " (dashed)" : ""}`).join(", ");
  const notes = legendLines(data).map((line) => `<p class="legend">${escapeHtml(line)}</p>`).join("\n");
  return figureHtml({
    kind: "move-map",
    title: data.title,
    description: `A folder tree of ${rows.length} rows with ${edges.length} arrows from a unit's folder to its target folder and ${data.marks.length} markers. Kinds: ${kindText}. Each arrow is numbered and its row prints its ${data.valueLabel}; the table below lists every arrow and marker.`,
    width: Math.ceil(textX + widest + MARGIN),
    height: Math.max(ROW, heights.reduce((sum, h) => sum + h, 0)),
    drawing: [...lines, ...arrows].join("\n"),
    table: htmlTable(tableCaption(data), data.table.columns, data.table.rows.map((row) => row.map(escapeHtml)), { rowHeaders: true }),
    notes: `${notes}\n`,
  });
}

export function moveMapMd(data: MoveMapData): string {
  return [`**${escapeMd(data.title)}**`, "", mdTable(data.table.columns, data.table.rows), "", ...legendLines(data).map((line) => `- ${escapeMd(line)}`)].join("\n");
}
