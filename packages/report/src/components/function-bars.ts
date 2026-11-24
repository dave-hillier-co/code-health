import { count, escapeHtml, escapeMd, formatNumber } from "../text.ts";
import { htmlTable, mdTable } from "../tables.ts";
import { figureHtml } from "./figure.ts";
import { linked } from "../links.ts";

export interface FunctionBar {
  /** The function's name as the page prints it. */
  label: string;
  /** The measure the bars show, such as cognitive complexity. */
  value: number;
  /** Landed changes of the window that touched the function, or null when no history figure exists. */
  revisions: number | null;
  /** Fix changes among them, or null when no fix figure exists. */
  fixes: number | null;
  /** Links the bar and its table row to where the function is described, on this page or another report page. Html only. */
  href?: string;
}

export interface FunctionBarsData {
  title: string;
  /** What the bar length is, such as "cognitive complexity". */
  unit: string;
  /** The guideline for the value. A bar above it is marked with a triangle and the words "above guideline". */
  guideline: number;
  /** Where the guideline comes from, shown under the chart. */
  source?: string;
  /** In the order to draw. */
  bars: FunctionBar[];
  /** Functions of the same file the chart leaves out, and the reason, for the legend. */
  omitted?: { count: number; reason: string };
}

const WIDTH = 760;
const HEADER = 22;
const ROW = 26;
const LABEL = 250;
const BAR_MAX = 260;
const REVISIONS_X = 660;
const FIXES_X = 740;
const LABEL_CHARS = 36;

/** Cuts the start of a long name, since the end of a nested name (`Class.Method.Inner`) tells functions apart. The full name is the tooltip and the table. */
const shorten = (text: string) => (text.length <= LABEL_CHARS ? text : `…${text.slice(text.length - LABEL_CHARS + 1)}`);
const figure = (value: number | null) => (value === null ? "none" : formatNumber(value));
const position = (bar: FunctionBar, guideline: number) => (bar.value > guideline ? "above guideline" : bar.value === guideline ? "at guideline" : "below guideline");

const columns = (data: FunctionBarsData) => [
  { label: "Function" },
  { label: data.unit, align: "right" as const },
  { label: "Guideline", align: "right" as const },
  { label: "Position" },
  { label: "Revisions", align: "right" as const },
  { label: "Fixes", align: "right" as const },
];
const rows = (data: FunctionBarsData) => data.bars.map((b) => [b.label, formatNumber(b.value), formatNumber(data.guideline), position(b, data.guideline), figure(b.revisions), figure(b.fixes)]);

const omittedText = (data: FunctionBarsData) => (data.omitted === undefined || data.omitted.count === 0 ? undefined : `The chart omits ${count(data.omitted.count, "function")}: ${data.omitted.reason}.`);

export function functionBarsHtml(data: FunctionBarsData): string {
  const greatest = Math.max(1, data.guideline, ...data.bars.map((b) => b.value));
  const scale = BAR_MAX / greatest;
  const marker = LABEL + data.guideline * scale;
  const header = `<g class="column-heads"><text x="${LABEL - 6}" y="14" text-anchor="end">Function</text><text x="${LABEL}" y="14">${escapeHtml(data.unit)}</text><text x="${REVISIONS_X}" y="14" text-anchor="end">Revisions</text><text x="${FIXES_X}" y="14" text-anchor="end">Fixes</text></g>`;
  const drawing = [
    header,
    ...data.bars.map((b, i) => {
      const y = HEADER + i * ROW;
      const width = b.value * scale;
      const above = b.value > data.guideline;
      return linked(`<g class="bar ${above ? "above" : "within"}"><text x="${LABEL - 6}" y="${y + 17}" text-anchor="end">${escapeHtml(shorten(b.label))}<title>${escapeHtml(b.label)}</title></text><rect x="${LABEL}" y="${y + 4}" width="${width.toFixed(1)}" height="${ROW - 8}"/><line x1="${marker.toFixed(1)}" x2="${marker.toFixed(1)}" y1="${y + 1}" y2="${y + ROW - 1}"/><text x="${(LABEL + Math.max(width, data.guideline * scale) + 8).toFixed(1)}" y="${y + 17}">${above ? "▲ " : ""}${formatNumber(b.value)}</text><text x="${REVISIONS_X}" y="${y + 17}" text-anchor="end">${figure(b.revisions)}</text><text x="${FIXES_X}" y="${y + 17}" text-anchor="end">${figure(b.fixes)}</text></g>`, b.href);
    }),
  ].join("\n");
  const omitted = omittedText(data);
  const notes = [
    `The vertical line marks the guideline of ${formatNumber(data.guideline)} and ▲ marks a function above it. A guideline orders and labels results; it decides nothing.${data.source === undefined ? "" : ` ${escapeHtml(data.source)}`}`,
    ...(omitted === undefined ? [] : [escapeHtml(omitted)]),
  ];
  return figureHtml({
    kind: "function-bars",
    title: data.title,
    description: `${count(data.bars.length, "function")} by ${data.unit}, each with its revisions and fixes in the history window. A bar longer than the guideline marker is above guideline, shown with a triangle and the words in the table.`,
    width: WIDTH,
    height: HEADER + Math.max(1, data.bars.length) * ROW,
    drawing,
    table: htmlTable(`${data.title}: ${data.unit}, revisions and fixes`, columns(data), rows(data).map((r, k) => r.map((cell, c) => (c === 0 ? linked(escapeHtml(cell), data.bars[k]?.href) : escapeHtml(cell)))), { rowHeaders: true }),
    notes: notes.map((line) => `<p class="legend">${line}</p>\n`).join(""),
  });
}

export function functionBarsMd(data: FunctionBarsData): string {
  const omitted = omittedText(data);
  return [
    `**${escapeMd(data.title)}** (${escapeMd(data.unit)} against a guideline of ${formatNumber(data.guideline)}, with revisions and fixes${data.source === undefined ? "" : `. ${escapeMd(data.source)}`})`,
    "",
    mdTable(columns(data), rows(data)),
    ...(omitted === undefined ? [] : ["", escapeMd(omitted)]),
  ].join("\n");
}
