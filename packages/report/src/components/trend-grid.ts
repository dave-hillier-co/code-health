import { clip, escapeHtml, escapeMd, formatNumber } from "../text.ts";
import { htmlTable, mdTable } from "../tables.ts";
import { linked } from "../links.ts";
import { figureHtml } from "./figure.ts";
import { noticeHtml, noticeMd } from "./notice.ts";
import { ARROW, trendOf, type Trend } from "./trend-marker.ts";

export interface TrendGridItem {
  /** What the panel is, such as a folder. */
  name: string;
  /** One value per label, oldest first. null where the item has no value, such as a folder before it existed. */
  values: (number | null)[];
  /** Links the panel's name and its table row to where the item is described. Html only. */
  href?: string;
}

export interface TrendGridData {
  title: string;
  /** What the values measure: "mean distance per use". */
  unit: string;
  /** What each sample is, one per value, oldest first. */
  labels: string[];
  /** One panel each, in the order given. */
  items: TrendGridItem[];
  /** How far the last value may differ from the first, as a fraction of it, and still be stable. Default 0.2. */
  tolerance?: number;
  /** The words printed for each trend, when "stronger" and "weaker" do not describe the quantity. */
  wording?: Partial<Record<Trend, string>>;
  /** A sentence printed under the grid. */
  note?: string;
  /** Replaces the line printed instead of the grid when there are fewer than two samples or no items. */
  emptyText?: string;
}

const COLUMNS = 4;
const CELL_W = 190;
const CELL_H = 96;
const PAD = 10;
const LINE_TOP = 22;
const LINE_H = 40;
const MAX_NAME = 28;

/** What one item shows: its first and last values, the samples they belong to, and the trend between them. */
export interface TrendReading {
  first: { label: string; value: number } | null;
  last: { label: string; value: number } | null;
  /** The last sample has no value: the item is no longer there. */
  ended: boolean;
  trend: Trend | null;
}

/** The first and last values an item has, and the trend from one to the other. A single value has no trend. */
export function readTrend(labels: readonly string[], values: readonly (number | null)[], tolerance?: number): TrendReading {
  const from = values.findIndex((v) => v !== null);
  const to = values.findLastIndex((v) => v !== null);
  if (from === -1) return { first: null, last: null, ended: true, trend: null };
  const first = { label: labels[from]!, value: values[from]! };
  const last = { label: labels[to]!, value: values[to]! };
  return { first, last, ended: to !== values.length - 1, trend: from === to ? null : trendOf(first.value, last.value, tolerance) };
}

const emptyOf = (data: TrendGridData) => (data.labels.length < 2 || data.items.length === 0 ? (data.emptyText ?? `${data.title}: fewer than two samples, so there is no trend to draw.`) : undefined);

function wordOf(data: TrendGridData, reading: TrendReading): string {
  if (reading.first === null) return "no value";
  if (reading.ended) return `no value after ${reading.last!.label}`;
  if (reading.trend === null) return `first seen ${reading.first.label}`;
  return data.wording?.[reading.trend] ?? reading.trend;
}

const columns = (data: TrendGridData) => [
  { label: "Item" },
  { label: "First sample" },
  { label: `First ${data.unit}`, align: "right" as const },
  { label: `Last ${data.unit}`, align: "right" as const },
  { label: "Change", align: "right" as const },
  { label: "Trend" },
];

function rows(data: TrendGridData): string[][] {
  return data.items.map((item) => {
    const reading = readTrend(data.labels, item.values, data.tolerance);
    const change = reading.first === null || reading.last === null ? "" : formatNumber(reading.last.value - reading.first.value);
    return [item.name, reading.first?.label ?? "none", reading.first === null ? "none" : formatNumber(reading.first.value), reading.last === null ? "none" : formatNumber(reading.last.value), change, wordOf(data, reading)];
  });
}

const legend = (data: TrendGridData) => [
  `Every panel has the same vertical scale, from 0 to the greatest value in the grid, so the heights compare between panels.`,
  `A trend compares an item's first value with its last: a change within ${formatNumber((data.tolerance ?? 0.2) * 100)} percent of the first value is ${data.wording?.stable ?? "stable"}. The tolerance is a guideline that labels the change; the table gives the values.`,
  ...(data.note === undefined ? [] : [data.note]),
];

export function trendGridHtml(data: TrendGridData): string {
  const empty = emptyOf(data);
  if (empty !== undefined) return noticeHtml({ level: "notice", text: empty });
  const top = Math.max(1e-9, ...data.items.flatMap((item) => item.values.filter((v): v is number => v !== null)));
  const width = COLUMNS * CELL_W;
  const height = Math.ceil(data.items.length / COLUMNS) * CELL_H;
  const at = (v: number) => v.toFixed(1);
  const panels = data.items.map((item, k) => {
    const x0 = (k % COLUMNS) * CELL_W;
    const y0 = Math.floor(k / COLUMNS) * CELL_H;
    const px = (i: number) => x0 + PAD + (i * (CELL_W - 2 * PAD)) / (data.labels.length - 1);
    const py = (v: number) => y0 + LINE_TOP + (1 - Math.max(0, v) / top) * LINE_H;
    const reading = readTrend(data.labels, item.values, data.tolerance);
    const segments: string[][] = [[]];
    item.values.forEach((v, i) => {
      if (v === null) segments.push([]);
      else segments.at(-1)!.push(`${at(px(i))},${at(py(v))}`);
    });
    const line = segments.filter((seg) => seg.length > 1).map((seg) => `<polyline points="${seg.join(" ")}"/>`).join("");
    const lastIndex = item.values.findLastIndex((v) => v !== null);
    const dot = lastIndex === -1 ? "" : `<circle cx="${at(px(lastIndex))}" cy="${at(py(item.values[lastIndex]!))}" r="3"/>`;
    const values = reading.first === null ? "no value" : `${formatNumber(reading.first.value)} to ${formatNumber(reading.last!.value)}`;
    const arrow = reading.trend === null || reading.ended ? "" : `<tspan aria-hidden="true">${ARROW[reading.trend]} </tspan>`;
    const name = linked(`<text class="name" x="${x0 + PAD}" y="${y0 + 14}">${escapeHtml(clip(item.name, MAX_NAME))}</text>`, item.href);
    return [
      `<g class="panel${reading.trend === null ? "" : ` ${reading.trend}`}"><title>${escapeHtml(`${item.name}: ${values}, ${wordOf(data, reading)}`)}</title>`,
      `<rect class="frame" x="${x0 + 2}" y="${y0 + 2}" width="${CELL_W - 4}" height="${CELL_H - 4}"/>`,
      `<line class="grid" x1="${x0 + PAD}" y1="${at(y0 + LINE_TOP + LINE_H)}" x2="${x0 + CELL_W - PAD}" y2="${at(y0 + LINE_TOP + LINE_H)}"/>`,
      name,
      line,
      dot,
      `<text class="reading" x="${x0 + PAD}" y="${y0 + CELL_H - 22}">${escapeHtml(values)}</text>`,
      `<text class="word" x="${x0 + PAD}" y="${y0 + CELL_H - 9}">${arrow}${escapeHtml(wordOf(data, reading))}</text>`,
      `</g>`,
    ].join("");
  });
  const counts = new Map<string, number>();
  for (const item of data.items) {
    const word = wordOf(data, readTrend(data.labels, item.values, data.tolerance));
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return figureHtml({
    kind: "trend-grid",
    title: data.title,
    description: `${formatNumber(data.items.length)} small line charts of ${data.unit}, one per item, over ${data.labels.length} samples from ${data.labels[0]} to ${data.labels.at(-1)}, all on one vertical scale. ${[...counts].map(([word, n]) => `${formatNumber(n)} ${word}`).join(", ")}. The table below lists each item's first and last values.`,
    width,
    height,
    drawing: panels.join("\n"),
    table: htmlTable(`${data.title}: first and last ${data.unit} of each item`, columns(data), rows(data).map((r, k) => r.map((c, i) => (i === 0 ? linked(escapeHtml(c), data.items[k]?.href) : escapeHtml(c)))), { rowHeaders: true }),
    fold: `Table of the ${formatNumber(data.items.length)} items`,
    notes: legend(data).map((n) => `<p class="legend">${escapeHtml(n)}</p>\n`).join(""),
  });
}

export function trendGridMd(data: TrendGridData): string {
  const empty = emptyOf(data);
  if (empty !== undefined) return noticeMd({ level: "notice", text: empty });
  return [`**${escapeMd(data.title)}** (${escapeMd(data.unit)}, ${escapeMd(data.labels[0]!)} to ${escapeMd(data.labels.at(-1)!)})`, "", mdTable(columns(data), rows(data)), "", legend(data).slice(1).map((n) => `_${escapeMd(n)}_`).join("\n\n")].join("\n");
}
