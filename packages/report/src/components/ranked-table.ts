import { linked } from "../links.ts";
import { escapeHtml, escapeMd, formatNumber, inlineHtml } from "../text.ts";
import { noticeHtml, noticeMd } from "./notice.ts";
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
  /** What to print when `rows` is empty, and why: "No cycles were found at the default level." Without it the line is "<caption>: no rows." */
  emptyText?: string;
  /** `rowIds[i]` is the html id of `rows[i]`, which links on the page point at. Build it with `targetId`, so ids stay unique on the page. */
  rowIds?: (string | null)[];
  /** `cellHrefs[i][key]` links the cell of column `key` in `rows[i]` (a `#id` on the page or a `report:` reference). Html only. */
  cellHrefs?: Record<string, string>[];
  /** Links printed under the table, each to a page or place that tells more of it. A link whose `href` is dropped (its page is not beside this one) is not printed. Html only. */
  seeAlso?: { href?: string; text: string }[];
  /** The command whose output lists every row, set by `capRows`. With it the omitted-rows line reads "N of M shown; the rest are in `<command>` output." */
  fullIn?: string;
}

/** The one-line notice for a table with no rows, or undefined when it has rows. */
export function rankedTableEmpty(data: RankedTableData): string | undefined {
  return data.rows.length > 0 ? undefined : (data.emptyText ?? `${data.caption}: no rows.`);
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
  if (data.fullIn !== undefined) return `${formatNumber(data.rows.length)} of ${formatNumber(data.total)} shown; the rest are in \`${data.fullIn}\` output.`;
  return `Showing ${formatNumber(data.rows.length)} of ${formatNumber(data.total)}${data.noun === undefined ? "" : ` ${data.noun}`}; ${formatNumber(left)} not shown.`;
}

export function rankedTableHtml(data: RankedTableData): string {
  const empty = rankedTableEmpty(data);
  if (empty !== undefined) return noticeHtml({ level: "notice", text: empty });
  const cell = (column: RankedColumn, value: Cell, href: string | undefined): string => {
    const shown = linked(escapeHtml(text(value)), href);
    if (!marked(column, value)) return shown;
    const side = column.guideline?.direction === "below" ? "below" : "above";
    return `${shown} <span class="marker ${side}" title="${side} guideline">${MARK[side]}<span class="visually-hidden"> ${side} guideline</span></span>`;
  };
  const columns = [...rankColumn(data), ...data.columns.map((c) => ({ label: c.label, align: c.align }))];
  const rows = data.rows.map((row, i) => [...rankCell(data, i), ...data.columns.map((c) => cell(c, row[c.key] ?? null, data.cellHrefs?.[i]?.[c.key]))]);
  const table = htmlTable(data.caption, columns, rows, { rowHeaders: data.numbered === false, className: "ranked", ...(data.rowIds === undefined ? {} : { rowIds: data.rowIds }) });
  const notes = [legend(data), omitted(data)].flatMap((n) => (n === undefined ? [] : [`<p class="legend">${inlineHtml(n)}</p>`]));
  for (const see of data.seeAlso ?? []) if (see.href !== undefined) notes.push(`<p class="legend">${linked(escapeHtml(see.text), see.href)}</p>`);
  return [table, ...notes].join("\n");
}

export function rankedTableMd(data: RankedTableData): string {
  const empty = rankedTableEmpty(data);
  if (empty !== undefined) return noticeMd({ level: "notice", text: empty });
  const columns = [...rankColumn(data), ...data.columns.map((c) => ({ label: c.label, align: c.align }))];
  const rows = data.rows.map((row, i) => [...rankCell(data, i), ...data.columns.map((c) => `${text(row[c.key] ?? null)}${marked(c, row[c.key] ?? null) ? ` ${MARK[c.guideline?.direction === "below" ? "below" : "above"]}` : ""}`)]);
  return [
    `**${escapeMd(data.caption)}**`,
    "",
    mdTable(columns, rows),
    ...[legend(data), omitted(data)].flatMap((n) => (n === undefined ? [] : ["", `_${escapeMd(n)}_`])),
  ].join("\n");
}
