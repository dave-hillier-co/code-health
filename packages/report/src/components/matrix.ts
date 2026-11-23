import { escapeHtml, escapeMd, formatNumber } from "../text.ts";
import { htmlTable, mdTable } from "../tables.ts";
import { bandLegend, makeBands } from "./bands.ts";
import { figureHtml } from "./figure.ts";

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
}

const CELL_W = 64;
const CELL_H = 26;
const ROW_LABEL = 180;
const COLUMN_LABEL = 90;

const display = (value: number | null) => (value === null ? "none" : formatNumber(value));

export function matrixHtml(data: MatrixData): string {
  const present = data.cells.flat().flatMap((v) => (v === null ? [] : [v]));
  const bands = makeBands(present, data.breaks);
  const labels = [
    ...data.columns.map((c, j) => `<text x="${ROW_LABEL + j * CELL_W + CELL_W / 2}" y="${COLUMN_LABEL - 6}" transform="rotate(-35 ${ROW_LABEL + j * CELL_W + CELL_W / 2} ${COLUMN_LABEL - 6})">${escapeHtml(c)}</text>`),
    ...data.rows.map((r, i) => `<text x="${ROW_LABEL - 6}" y="${COLUMN_LABEL + i * CELL_H + 17}" text-anchor="end">${escapeHtml(r)}</text>`),
  ];
  const cells = data.rows.flatMap((_, i) =>
    data.columns.map((_, j) => {
      const value = data.cells[i]?.[j] ?? null;
      const x = ROW_LABEL + j * CELL_W;
      const y = COLUMN_LABEL + i * CELL_H;
      return `<g class="cell band-${value === null ? "none" : bands.of(value)}"><rect x="${x}" y="${y}" width="${CELL_W - 2}" height="${CELL_H - 2}"/><text x="${x + CELL_W / 2 - 1}" y="${y + 16}" text-anchor="middle">${display(value)}</text></g>`;
    }),
  );
  return figureHtml({
    kind: "matrix",
    title: data.title,
    description: `A grid of ${data.rows.length} rows by ${data.columns.length} columns holding ${data.valueLabel}. Each cell prints its value; the table below lists the same values.`,
    width: ROW_LABEL + data.columns.length * CELL_W + 40,
    height: COLUMN_LABEL + data.rows.length * CELL_H + 4,
    drawing: [...labels, ...cells].join("\n"),
    table: htmlTable(`${data.title}: ${data.valueLabel}`, [{ label: "" }, ...data.columns.map((c) => ({ label: c, align: "right" as const }))], data.rows.map((r, i) => [escapeHtml(r), ...data.columns.map((_, j) => escapeHtml(display(data.cells[i]?.[j] ?? null)))]), { rowHeaders: true }),
    notes: `<p class="legend">Colour is ${escapeHtml(data.valueLabel)} in five bands, and each cell prints its value: ${escapeHtml(bandLegend(bands))}. Hatched cells have no value.</p>\n`,
  });
}

export function matrixMd(data: MatrixData): string {
  const present = data.cells.flat().flatMap((v) => (v === null ? [] : [v]));
  const bands = makeBands(present, data.breaks);
  return [
    `**${escapeMd(data.title)}** (${escapeMd(data.valueLabel)}; ${bandLegend(bands)})`,
    "",
    mdTable([{ label: "" }, ...data.columns.map((c) => ({ label: c, align: "right" as const }))], data.rows.map((r, i) => [r, ...data.columns.map((_, j) => display(data.cells[i]?.[j] ?? null))])),
  ].join("\n");
}
