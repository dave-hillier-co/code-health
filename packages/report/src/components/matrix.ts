import { clip, count, escapeHtml, escapeMd, formatNumber } from "../text.ts";
import { htmlTable, mdTable, type TableColumn } from "../tables.ts";
import { bandCountText, bandLegend, makeBands } from "./bands.ts";
import { figureHtml } from "./figure.ts";

/** A kind of cell a matrix marks beside its value, such as an expected pair or a dependency against the layering. */
export interface MatrixMark {
  /** Printed after the value in the cell and the table, so the mark is never colour alone. One or two characters. */
  symbol: string;
  /** What the mark means, in words, for the legend. */
  text: string;
}

export interface MatrixGroup {
  label: string;
  /** Index of the first row in the group. */
  start: number;
  /** Index of the last row in the group, inclusive. */
  end: number;
}

/** Consecutive rows (and, for a square matrix, the same columns) that belong together, such as the components of one tree. */
export interface MatrixSpan {
  label: string;
  /** Index of the first row in the span. */
  start: number;
  /** Index of the last row in the span, inclusive. */
  end: number;
}

export interface MatrixData {
  title: string;
  /** What each cell holds, such as "shared changes". */
  valueLabel: string;
  rows: string[];
  columns: string[];
  /** `cells[row][column]`; null where there is no value. */
  cells: (number | null)[][];
  /** Four ascending values that split the bands. Without them the value range splits into five equal steps. */
  breaks?: number[];
  /** The marks this matrix uses, keyed by name. */
  marks?: Record<string, MatrixMark>;
  /** `cellMarks[row][column]`: the name of the cell's mark in `marks`, or null. A marked cell with no value prints its symbol alone. */
  cellMarks?: (string | null)[][];
  /** Rows that belong together, drawn as a box along the diagonal. Only for a square matrix whose rows and columns are the same list in the same order. */
  groups?: MatrixGroup[];
  /**
   * Consecutive rows that belong together, each drawn as a labelled bar to the left of the row labels, and for a square matrix
   * above the column labels too, with a thin line across the grid at each boundary. Each span has its own colour class
   * (`span-1` to `span-6`, repeating), and its label is printed, so colour is not the only signal.
   */
  spans?: MatrixSpan[];
  /** How the rows are ordered, printed under the chart, such as "Rows are ordered by cluster, then by sum of coupling". */
  orderText?: string;
}

/** Cells are square. The side fits the longest printed cell text, between these bounds. */
const CELL_MIN = 24;
const CELL_MAX = 56;
const CELL_PAD = 8;
/** Least space for the row labels and the rotated column labels; both grow to fit the longest label. */
const ROW_LABEL = 180;
const COLUMN_LABEL = 90;
/** Labels longer than this are cut with an ellipsis in the drawing; the table and the hover title keep the whole text. */
const LABEL_CHARS = 32;
/** Width of a character of the 11px label font, with room for wide letters. */
const CHAR_W = 6.4;
const LABEL_ANGLE = 35;
/** Thickness of a span bar, and the gap between it and the labels. */
const SPAN_BAR = 18;
const SPAN_GAP = 4;
const SPAN_COLOURS = 6;

const display = (value: number | null) => (value === null ? "" : formatNumber(value));

const markOf = (data: MatrixData, i: number, j: number): MatrixMark | undefined => {
  const name = data.cellMarks?.[i]?.[j] ?? null;
  return name === null ? undefined : data.marks?.[name];
};

/** The cell's text: its value, then its mark's symbol. A marked cell with no value prints its symbol alone. */
function cellText(data: MatrixData, i: number, j: number): string {
  const value = data.cells[i]?.[j] ?? null;
  const mark = markOf(data, i, j);
  if (mark === undefined) return display(value);
  return value === null ? mark.symbol : `${formatNumber(value)} ${mark.symbol}`;
}

const isSquare = (data: MatrixData) => data.rows.length === data.columns.length && data.rows.every((r, i) => r === data.columns[i]);

const usableGroups = (data: MatrixData): MatrixGroup[] =>
  isSquare(data) ? (data.groups ?? []).filter((g) => g.start >= 0 && g.end >= g.start && g.end < data.rows.length) : [];

/** The legend line for the marks: each symbol, what it means and how many cells carry it. Only marks that some cell uses. */
function markLegend(data: MatrixData): string | undefined {
  if (data.marks === undefined || data.cellMarks === undefined) return undefined;
  const counts = new Map<string, number>();
  for (const row of data.cellMarks) for (const name of row) if (name !== null && data.marks[name] !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1);
  const parts = Object.entries(data.marks).filter(([name]) => counts.has(name)).map(([name, mark]) => `${mark.symbol} is ${mark.text} (${count(counts.get(name)!, "cell")})`);
  return parts.length === 0 ? undefined : `${parts.join("; ")}.`;
}

const usableSpans = (data: MatrixData): MatrixSpan[] =>
  (data.spans ?? []).filter((g) => g.start >= 0 && g.end >= g.start && g.end < data.rows.length).sort((a, b) => a.start - b.start);

function spanLegend(spans: readonly MatrixSpan[], square: boolean): string | undefined {
  if (spans.length === 0) return undefined;
  const where = square ? "above the columns and left of the rows" : "left of the rows";
  return `Bars ${where} mark ${count(spans.length, "span")}: ${spans.map((g) => `${g.label} (${count(g.end - g.start + 1, "row")})`).join(", ")}.`;
}

function groupLegend(groups: readonly MatrixGroup[]): string | undefined {
  if (groups.length === 0) return undefined;
  return `Boxes along the diagonal mark ${count(groups.length, "group")}: ${groups.map((g) => `${g.label} (${count(g.end - g.start + 1, "row")})`).join(", ")}.`;
}

/**
 * The cells that have a value or a mark, one row per cell in row order then column order, with the row's and the column's
 * span or group when the matrix has any. A matrix of 25 columns does not fit a grid table, and a list has no empty cells.
 */
function cellList(data: MatrixData, spans: readonly MatrixSpan[], groups: readonly MatrixGroup[]) {
  const square = isSquare(data);
  const named = spans.length > 0 || groups.length > 0;
  const namesOf = (i: number) =>
    [spans.find((g) => i >= g.start && i <= g.end)?.label, groups.find((g) => i >= g.start && i <= g.end)?.label].filter((label): label is string => label !== undefined).join(", ");
  const columns: TableColumn[] = [
    { label: "Row" },
    { label: "Column" },
    { label: "Value", align: "right" },
    { label: "Mark" },
    ...(named ? [{ label: "Row group" }, ...(square ? [{ label: "Column group" }] : [])] : []),
  ];
  const rows: string[][] = [];
  for (const [i, r] of data.rows.entries()) {
    for (const [j, c] of data.columns.entries()) {
      const value = data.cells[i]?.[j] ?? null;
      const mark = markOf(data, i, j);
      if (value === null && mark === undefined) continue;
      rows.push([r, c, display(value), mark?.text ?? "", ...(named ? [namesOf(i), ...(square ? [namesOf(j)] : [])] : [])]);
    }
  }
  return { columns, rows, blank: data.rows.length * data.columns.length - rows.length };
}

/** The side of a cell: wide enough for the longest value and mark printed in any cell. */
function cellSize(data: MatrixData): number {
  let longest = 1;
  for (const i of data.rows.keys()) for (const j of data.columns.keys()) longest = Math.max(longest, cellText(data, i, j).length);
  return Math.min(CELL_MAX, Math.max(CELL_MIN, Math.ceil(longest * CHAR_W) + CELL_PAD));
}

export function matrixHtml(data: MatrixData): string {
  const cell = cellSize(data);
  const present = data.cells.flat().flatMap((v) => (v === null ? [] : [v]));
  const bands = makeBands(present, data.breaks);
  const groups = usableGroups(data);
  const spans = usableSpans(data);
  const square = isSquare(data);
  const rowText = data.rows.map((r) => clip(r, LABEL_CHARS));
  const columnText = data.columns.map((c) => clip(c, LABEL_CHARS));
  const longest = (labels: readonly string[]) => Math.max(0, ...labels.map((l) => l.length));
  const rowLabel = Math.max(ROW_LABEL, Math.ceil(longest(rowText) * CHAR_W) + 12);
  // A label rotated by LABEL_ANGLE rises by its length times sin(angle) and runs right by its length times cos(angle).
  const rise = longest(columnText) * CHAR_W * Math.sin((LABEL_ANGLE * Math.PI) / 180);
  const columnLabel = Math.max(COLUMN_LABEL, Math.ceil(rise) + 16);
  const reach = longest(columnText) * CHAR_W * Math.cos((LABEL_ANGLE * Math.PI) / 180);
  const left = spans.length > 0 ? SPAN_BAR + SPAN_GAP : 0;
  const top = spans.length > 0 && square ? SPAN_BAR + SPAN_GAP : 0;
  const gridX = left + rowLabel;
  const gridY = top + columnLabel;
  const labels = [
    ...data.columns.map((c, j) => {
      const x = gridX + j * cell + cell / 2;
      const y = gridY - 6;
      return `<text x="${x}" y="${y}" transform="rotate(-${LABEL_ANGLE} ${x} ${y})">${escapeHtml(columnText[j]!)}${columnText[j] === c ? "" : `<title>${escapeHtml(c)}</title>`}</text>`;
    }),
    ...data.rows.map((r, i) => `<text x="${gridX - 6}" y="${gridY + i * cell + (cell - 2) / 2}" dominant-baseline="central" text-anchor="end">${escapeHtml(rowText[i]!)}${rowText[i] === r ? "" : `<title>${escapeHtml(r)}</title>`}</text>`),
  ];
  const cells = data.rows.flatMap((_, i) =>
    data.columns.map((_, j) => {
      const value = data.cells[i]?.[j] ?? null;
      const name = data.cellMarks?.[i]?.[j] ?? null;
      const markClass = name !== null && data.marks?.[name] !== undefined ? ` mark-${name}` : "";
      const x = gridX + j * cell;
      const y = gridY + i * cell;
      return `<g class="cell band-${value === null ? "none" : bands.of(value)}${markClass}"><rect x="${x}" y="${y}" width="${cell - 2}" height="${cell - 2}"/>${cellText(data, i, j) === "" ? "" : `<text x="${x + (cell - 2) / 2}" y="${y + (cell - 2) / 2}" text-anchor="middle" dominant-baseline="central">${escapeHtml(cellText(data, i, j))}</text>`}</g>`;
    }),
  );
  const boxes = groups.map((g) => {
    const x = gridX + g.start * cell - 1;
    const y = gridY + g.start * cell - 1;
    const span = g.end - g.start + 1;
    return `<g class="group"><rect x="${x}" y="${y}" width="${span * cell}" height="${span * cell}"><title>${escapeHtml(g.label)}</title></rect></g>`;
  });
  const bars = spans.flatMap((g, k) => {
    const colour = `span span-${(k % SPAN_COLOURS) + 1}`;
    const rows = g.end - g.start + 1;
    const y = gridY + g.start * cell;
    const cy = y + (rows * cell - 2) / 2;
    const side = `<g class="${colour}"><rect x="0" y="${y}" width="${SPAN_BAR}" height="${rows * cell - 2}"/><text x="${SPAN_BAR / 2}" y="${cy}" text-anchor="middle" dominant-baseline="central" transform="rotate(-90 ${SPAN_BAR / 2} ${cy})">${escapeHtml(clip(g.label, Math.floor((rows * cell - 6) / CHAR_W)))}</text><title>${escapeHtml(g.label)}</title></g>`;
    if (!square) return [side];
    const x = gridX + g.start * cell;
    const w = rows * cell - 2;
    return [side, `<g class="${colour}"><rect x="${x}" y="0" width="${w}" height="${SPAN_BAR}"/><text x="${x + w / 2}" y="${SPAN_BAR / 2}" text-anchor="middle" dominant-baseline="central">${escapeHtml(clip(g.label, Math.floor((w - 6) / CHAR_W)))}</text><title>${escapeHtml(g.label)}</title></g>`];
  });
  const lines = spans.slice(1).flatMap((g) => {
    const y = gridY + g.start * cell - 1;
    const horizontal = `<line class="span-boundary" x1="${left}" y1="${y}" x2="${gridX + data.columns.length * cell}" y2="${y}"/>`;
    if (!square) return [horizontal];
    const x = gridX + g.start * cell - 1;
    return [horizontal, `<line class="span-boundary" x1="${x}" y1="${top}" x2="${x}" y2="${gridY + data.rows.length * cell}"/>`];
  });
  const list = cellList(data, spans, groups);
  const notes = [
    `Colour is ${data.valueLabel} in ${bandCountText(bands)}, and each cell prints its value: ${bandLegend(bands)}. Hatched blank cells have no value (${count(list.blank, "cell")} of ${count(data.rows.length * data.columns.length, "cell")}).`,
    markLegend(data),
    spanLegend(spans, square),
    groupLegend(groups),
    data.orderText,
  ].filter((line): line is string => line !== undefined);
  const description = [
    `A grid of ${data.rows.length} rows by ${data.columns.length} columns holding ${data.valueLabel}.`,
    spans.length > 0 ? `${count(spans.length, "bar")} mark ${spans.length === 1 ? "a span" : "spans"} of consecutive rows: ${spans.map((g) => g.label).join(", ")}.` : undefined,
    groups.length > 0 ? `${count(groups.length, "box", "boxes")} along the diagonal mark groups of rows.` : undefined,
    "Each cell prints its value; the table below lists every cell that has a value or a mark.",
  ].filter((line): line is string => line !== undefined).join(" ");
  return figureHtml({
    kind: "matrix",
    title: data.title,
    description,
    width: Math.ceil(gridX + Math.max(data.columns.length * cell + 40, (data.columns.length - 0.5) * cell + reach + 8)),
    height: gridY + data.rows.length * cell + 4,
    drawing: [...bars, ...labels, ...cells, ...boxes, ...lines].join("\n"),
    table: htmlTable(`${data.title}: ${data.valueLabel}, the cells that have a value or a mark`, list.columns, list.rows.map((row) => row.map(escapeHtml))),
    notes: `<p class="legend">${notes.map(escapeHtml).join(" ")}</p>\n`,
  });
}

export function matrixMd(data: MatrixData): string {
  const present = data.cells.flat().flatMap((v) => (v === null ? [] : [v]));
  const bands = makeBands(present, data.breaks);
  const groups = usableGroups(data);
  const spans = usableSpans(data);
  const list = cellList(data, spans, groups);
  const extra = [`The table lists the cells that have a value or a mark, in row order then column order. Blank cells have no value (${count(list.blank, "cell")} of ${count(data.rows.length * data.columns.length, "cell")}).`, markLegend(data), spanLegend(spans, isSquare(data)), groupLegend(groups), data.orderText].filter((line): line is string => line !== undefined);
  return [
    `**${escapeMd(data.title)}** (${escapeMd(data.valueLabel)}; ${bandLegend(bands)})`,
    "",
    mdTable(list.columns, list.rows),
    "",
    escapeMd(extra.join(" ")),
  ].join("\n");
}
