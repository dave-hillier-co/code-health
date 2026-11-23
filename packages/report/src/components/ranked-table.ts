import { escapeHtml, escapeMd, formatNumber } from "../text.ts";
import { htmlTable, mdTable, type Align } from "../tables.ts";

export type Cell = string | number | null;

export interface Guideline {
  value: number;
  /** Where the value comes from, shown in the legend. */
  note?: string;
  /** Which side of the guideline is marked. Default "above". */
  direction?: "above" | "below";
}

export interface RankedColumn {
  key: string;
  label: string;
  align?: Align;
  guideline?: Guideline;
}

export interface RankedTableData {
  caption: string;
  columns: RankedColumn[];
  /** In the order to show them: the table does not sort. The first column names the row. */
  rows: Record<string, Cell>[];
  /** The rows there are before the cut, when `rows` is only the top of them. */
  total?: number;
  /** What the rows are, for the count of those not shown: "files". */
  noun?: string;
  /** Print a rank in a first column. Default true; a table that lists counts by kind has no order to number. */
  numbered?: boolean;
}

/** The marker printed beside a value on the marked side of its column's guideline. */
export const MARK = { above: "▲", below: "▼" } as const;

/** Whether a cell is on the marked side of its column's guideline. */
export function marked(column: RankedColumn, value: Cell): boolean {
  if (typeof value !== "number" || column.guideline === undefined) return false;
  return column.guideline.direction === "below" ? value < column.guideline.value : value > column.guideline.value;
}

const rankColumn = (data: RankedTableData) => (data.numbered === false ? [] : [{ label: "#", align: "right" as const }]);
const rankCell = (data: RankedTableData, index: number) => (data.numbered === false ? [] : [String(index + 1)]);

function text(value: Cell): string {
  return value === null ? "–" : typeof value === "number" ? formatNumber(value) : value;
}

function legend(data: RankedTableData): string | undefined {
  const entries = data.columns.flatMap((column) => {
    if (column.guideline === undefined) return [];
    const side = column.guideline.direction === "below" ? "below" : "above";
    return [`${column.label} ${formatNumber(column.guideline.value)}${column.guideline.note === undefined ? "" : ` (${column.guideline.note})`}, ${MARK[side]} marks a value ${side} it`];
  });
  return entries.length === 0 ? undefined : `Guidelines order and label the rows and decide nothing. ${entries.join("; ")}.`;
}

function omitted(data: RankedTableData): string | undefined {
  if (data.total === undefined || data.total <= data.rows.length) return undefined;
  const left = data.total - data.rows.length;
  return `Showing ${formatNumber(data.rows.length)} of ${formatNumber(data.total)}${data.noun === undefined ? "" : ` ${data.noun}`}; ${formatNumber(left)} not shown.`;
}

export function rankedTableHtml(data: RankedTableData): string {
  const cell = (column: RankedColumn, value: Cell): string => {
    const shown = escapeHtml(text(value));
    if (!marked(column, value)) return shown;
    const side = column.guideline?.direction === "below" ? "below" : "above";
    return `${shown} <span class="marker ${side}" title="${side} guideline">${MARK[side]}<span class="visually-hidden"> ${side} guideline</span></span>`;
  };
  const columns = [...rankColumn(data), ...data.columns.map((c) => ({ label: c.label, align: c.align }))];
  const rows = data.rows.map((row, i) => [...rankCell(data, i), ...data.columns.map((c) => cell(c, row[c.key] ?? null))]);
  const table = data.rows.length === 0 ? `<p class="empty">${escapeHtml(data.caption)}: no rows.</p>` : htmlTable(data.caption, columns, rows, { rowHeaders: data.numbered === false, className: "ranked" });
  const notes = [legend(data), omitted(data)].flatMap((n) => (n === undefined ? [] : [`<p class="legend">${escapeHtml(n)}</p>`]));
  return [table, ...notes].join("\n");
}

export function rankedTableMd(data: RankedTableData): string {
  const columns = [...rankColumn(data), ...data.columns.map((c) => ({ label: c.label, align: c.align }))];
  const rows = data.rows.map((row, i) => [...rankCell(data, i), ...data.columns.map((c) => `${text(row[c.key] ?? null)}${marked(c, row[c.key] ?? null) ? ` ${MARK[c.guideline?.direction === "below" ? "below" : "above"]}` : ""}`)]);
  return [
    `**${escapeMd(data.caption)}**`,
    "",
    data.rows.length === 0 ? "No rows." : mdTable(columns, rows),
    ...[legend(data), omitted(data)].flatMap((n) => (n === undefined ? [] : ["", `_${escapeMd(n)}_`])),
  ].join("\n");
}
