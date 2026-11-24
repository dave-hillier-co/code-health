import { count, escapeHtml, escapeMd, formatNumber } from "../text.ts";
import { htmlTable, mdTable } from "../tables.ts";
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
  /** How the rows are ordered, printed under the chart, such as "Rows are ordered by cluster, then by sum of coupling". */
  orderText?: string;
}

const CELL_W = 64;
const CELL_H = 26;
const ROW_LABEL = 180;
const COLUMN_LABEL = 90;

const display = (value: number | null) => (value === null ? "none" : formatNumber(value));

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

function groupLegend(groups: readonly MatrixGroup[]): string | undefined {
  if (groups.length === 0) return undefined;
  return `Boxes along the diagonal mark ${count(groups.length, "group")}: ${groups.map((g) => `${g.label} (${count(g.end - g.start + 1, "row")})`).join(", ")}.`;
}

export function matrixHtml(data: MatrixData): string {
  const present = data.cells.flat().flatMap((v) => (v === null ? [] : [v]));
  const bands = makeBands(present, data.breaks);
  const groups = usableGroups(data);
  const labels = [
    ...data.columns.map((c, j) => `<text x="${ROW_LABEL + j * CELL_W + CELL_W / 2}" y="${COLUMN_LABEL - 6}" transform="rotate(-35 ${ROW_LABEL + j * CELL_W + CELL_W / 2} ${COLUMN_LABEL - 6})">${escapeHtml(c)}</text>`),
    ...data.rows.map((r, i) => `<text x="${ROW_LABEL - 6}" y="${COLUMN_LABEL + i * CELL_H + 17}" text-anchor="end">${escapeHtml(r)}</text>`),
  ];
  const cells = data.rows.flatMap((_, i) =>
    data.columns.map((_, j) => {
      const value = data.cells[i]?.[j] ?? null;
      const name = data.cellMarks?.[i]?.[j] ?? null;
      const markClass = name !== null && data.marks?.[name] !== undefined ? ` mark-${name}` : "";
      const x = ROW_LABEL + j * CELL_W;
      const y = COLUMN_LABEL + i * CELL_H;
      return `<g class="cell band-${value === null ? "none" : bands.of(value)}${markClass}"><rect x="${x}" y="${y}" width="${CELL_W - 2}" height="${CELL_H - 2}"/><text x="${x + CELL_W / 2 - 1}" y="${y + 16}" text-anchor="middle">${escapeHtml(cellText(data, i, j))}</text></g>`;
    }),
  );
  const boxes = groups.map((g) => {
    const x = ROW_LABEL + g.start * CELL_W - 1;
    const y = COLUMN_LABEL + g.start * CELL_H - 1;
    const span = g.end - g.start + 1;
    return `<g class="group"><rect x="${x}" y="${y}" width="${span * CELL_W}" height="${span * CELL_H}"><title>${escapeHtml(g.label)}</title></rect></g>`;
  });
  const notes = [
    `Colour is ${data.valueLabel} in ${bandCountText(bands)}, and each cell prints its value: ${bandLegend(bands)}. Hatched cells have no value.`,
    markLegend(data),
    groupLegend(groups),
    data.orderText,
  ].filter((line): line is string => line !== undefined);
  const description = [
    `A grid of ${data.rows.length} rows by ${data.columns.length} columns holding ${data.valueLabel}.`,
    groups.length > 0 ? `${count(groups.length, "box", "boxes")} along the diagonal mark groups of rows.` : undefined,
    "Each cell prints its value; the table below lists the same values.",
  ].filter((line): line is string => line !== undefined).join(" ");
  const groupOf = (i: number) => groups.find((g) => i >= g.start && i <= g.end)?.label;
  const rowLabel = (r: string, i: number) => {
    const group = groupOf(i);
    return group === undefined ? r : `${r} (${group})`;
  };
  return figureHtml({
    kind: "matrix",
    title: data.title,
    description,
    width: ROW_LABEL + data.columns.length * CELL_W + 40,
    height: COLUMN_LABEL + data.rows.length * CELL_H + 4,
    drawing: [...labels, ...cells, ...boxes].join("\n"),
    table: htmlTable(`${data.title}: ${data.valueLabel}`, [{ label: "" }, ...data.columns.map((c) => ({ label: c, align: "right" as const }))], data.rows.map((r, i) => [escapeHtml(rowLabel(r, i)), ...data.columns.map((_, j) => escapeHtml(cellText(data, i, j)))]), { rowHeaders: true }),
    notes: `<p class="legend">${notes.map(escapeHtml).join(" ")}</p>\n`,
  });
}

export function matrixMd(data: MatrixData): string {
  const present = data.cells.flat().flatMap((v) => (v === null ? [] : [v]));
  const bands = makeBands(present, data.breaks);
  const groups = usableGroups(data);
  const groupOf = (i: number) => groups.find((g) => i >= g.start && i <= g.end)?.label;
  const extra = [markLegend(data), groupLegend(groups), data.orderText].filter((line): line is string => line !== undefined);
  return [
    `**${escapeMd(data.title)}** (${escapeMd(data.valueLabel)}; ${bandLegend(bands)})`,
    "",
    mdTable([{ label: "" }, ...data.columns.map((c) => ({ label: c, align: "right" as const }))], data.rows.map((r, i) => {
      const group = groupOf(i);
      return [group === undefined ? r : `${r} (${group})`, ...data.columns.map((_, j) => cellText(data, i, j))];
    })),
    ...(extra.length === 0 ? [] : ["", escapeMd(extra.join(" "))]),
  ].join("\n");
}
