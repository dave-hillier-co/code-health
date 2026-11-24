import { clip, escapeHtml, escapeMd, formatNumber } from "../text.ts";
import { htmlTable, mdTable } from "../tables.ts";
import { figureHtml } from "./figure.ts";
import { noticeHtml, noticeMd } from "./notice.ts";

export interface TrendSeries {
  /** What the line is, such as a folder. Printed at the end of the line and as a column of the table. */
  name: string;
  /** One value per label, oldest first. null where the series has no value, which breaks the line. */
  values: (number | null)[];
}

export interface TrendChartData {
  title: string;
  /** What the values measure, printed on the vertical axis: "mean distance per use". */
  unit: string;
  /** What each sample is, one per value, oldest first: dates, or revisions. */
  labels: string[];
  /** The lines. The first six are drawn, each in its own colour with its name at its end; the table lists them all. */
  series: TrendSeries[];
  /** A sentence printed under the chart, such as what the values are indexed to. */
  note?: string;
  /** Replaces the line printed instead of the chart when there are fewer than two samples or no series. */
  emptyText?: string;
}

export const MAX_SERIES = 6;

const WIDTH = 760;
const HEIGHT = 320;
const LEFT = 60;
const RIGHT = 190;
const TOP = 14;
const BOTTOM = 44;
const PLOT_W = WIDTH - LEFT - RIGHT;
const PLOT_H = HEIGHT - TOP - BOTTOM;
const MAX_NAME = 28;
const LABEL_GAP = 13;
const X_TICKS = 6;
const CHAR_W = 6;

/** The least round number at or above `value`, for the top of an axis that starts at 0. */
export function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => s * power >= value) ?? 10;
  return Number((step * power).toPrecision(12));
}

const emptyOf = (data: TrendChartData) => (data.labels.length < 2 || data.series.length === 0 ? (data.emptyText ?? `${data.title}: fewer than two samples, so there is no trend to draw.`) : undefined);

const cell = (value: number | null) => (value === null ? "none" : formatNumber(value));
const columns = (data: TrendChartData) => [{ label: "Sample" }, ...data.series.map((s) => ({ label: s.name, align: "right" as const }))];
const rows = (data: TrendChartData) => data.labels.map((label, i) => [label, ...data.series.map((s) => cell(s.values[i] ?? null))]);

const present = (values: readonly (number | null)[]) => values.filter((v): v is number => v !== null);

/** A series in words: its first and last values, and the samples they belong to. */
function rangeText(data: TrendChartData, series: TrendSeries): string {
  const first = series.values.findIndex((v) => v !== null);
  const last = series.values.findLastIndex((v) => v !== null);
  if (first === -1) return `${series.name} has no value`;
  return `${series.name} goes from ${formatNumber(series.values[first]!)} (${data.labels[first]}) to ${formatNumber(series.values[last]!)} (${data.labels[last]})`;
}

/** The indexes of the samples whose label is printed under the axis: the first, the last and those evenly between. */
export function tickIndexes(count: number, most = X_TICKS): number[] {
  if (most < 2) return count === 0 ? [] : [0, count - 1].slice(0, count);
  if (count <= most) return Array.from({ length: count }, (_, i) => i);
  return [...new Set(Array.from({ length: most }, (_, i) => Math.round((i * (count - 1)) / (most - 1))))];
}

/** Moves the end labels apart so that none overlaps the next: each keeps its order and is at least one line below the one above. */
export function spreadLabels(ys: readonly number[], gap = LABEL_GAP, top = TOP + 4, bottom = TOP + PLOT_H): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  let floor = top;
  for (const item of order) {
    item.y = Math.max(item.y, floor);
    floor = item.y + gap;
  }
  let ceiling = bottom;
  for (const item of [...order].reverse()) {
    item.y = Math.min(item.y, ceiling);
    ceiling = item.y - gap;
  }
  const out = new Array<number>(ys.length);
  for (const item of order) out[item.i] = item.y;
  return out;
}

export function trendChartHtml(data: TrendChartData): string {
  const empty = emptyOf(data);
  if (empty !== undefined) return noticeHtml({ level: "notice", text: empty });
  const drawn = data.series.slice(0, MAX_SERIES);
  const top = niceCeiling(Math.max(0, ...drawn.flatMap((s) => present(s.values))));
  const at = (v: number) => v.toFixed(1);
  const px = (i: number) => LEFT + (i * PLOT_W) / (data.labels.length - 1);
  const py = (v: number) => TOP + (1 - Math.max(0, v) / top) * PLOT_H;
  const yTicks = [0, 1, 2, 3, 4].map((i) => (top * i) / 4);
  const grid = yTicks.map((v) => `<line class="grid" x1="${LEFT}" y1="${at(py(v))}" x2="${LEFT + PLOT_W}" y2="${at(py(v))}"/><text class="tick" x="${LEFT - 8}" y="${at(py(v) + 4)}" text-anchor="end">${formatNumber(Number(v.toPrecision(6)))}</text>`);
  // As many labels as fit side by side: a label with a time is wider than a date.
  const widest = Math.max(...data.labels.map((label) => label.length)) * CHAR_W + 14;
  const xTicks = tickIndexes(data.labels.length, Math.min(X_TICKS, Math.floor(PLOT_W / widest))).map((i) => `<text class="tick" x="${at(px(i))}" y="${TOP + PLOT_H + 16}" text-anchor="${i === 0 ? "start" : i === data.labels.length - 1 ? "end" : "middle"}">${escapeHtml(data.labels[i]!)}</text>`);
  const axisName = `<text class="axis" transform="rotate(-90 14 ${at(TOP + PLOT_H / 2)})" x="14" y="${at(TOP + PLOT_H / 2)}" text-anchor="middle">${escapeHtml(data.unit)}</text>`;

  const ends = drawn.map((s) => {
    const last = s.values.findLastIndex((v) => v !== null);
    return last === -1 ? null : { x: px(last), y: py(s.values[last]!) };
  });
  const labelYs = spreadLabels(ends.map((e) => (e === null ? TOP + PLOT_H : e.y + 4)));
  const lines = drawn.map((s, k) => {
    const segments: string[][] = [[]];
    s.values.forEach((v, i) => {
      if (v === null) segments.push([]);
      else segments.at(-1)!.push(`${at(px(i))},${at(py(v))}`);
    });
    const paths = segments.filter((seg) => seg.length > 1).map((seg) => `<polyline points="${seg.join(" ")}"/>`);
    const dots = s.values.map((v, i) => (v === null ? "" : `<circle cx="${at(px(i))}" cy="${at(py(v))}" r="2.5"><title>${escapeHtml(`${s.name}, ${data.labels[i]}: ${formatNumber(v)}`)}</title></circle>`));
    const end = ends[k];
    const name = end === null || end === undefined ? "" : `<text class="name" x="${at(LEFT + PLOT_W + 10)}" y="${at(labelYs[k]!)}">${escapeHtml(clip(s.name, MAX_NAME))} ${formatNumber(s.values.findLast((v) => v !== null)!)}</text>`;
    return `<g class="series cat-${k + 1}">${paths.join("")}${dots.join("")}${name}</g>`;
  });

  const left = data.series.length - drawn.length;
  const notes = [
    `The vertical axis starts at 0. Each line ends with its name and its last value.`,
    ...(left > 0 ? [`${formatNumber(left)} more series are in the table and are not drawn: the chart draws the first ${MAX_SERIES}.`] : []),
    ...(data.note === undefined ? [] : [data.note]),
  ];
  return figureHtml({
    kind: "trend-chart",
    title: data.title,
    description: `${data.unit} over ${data.labels.length} samples, from ${data.labels[0]} to ${data.labels.at(-1)}. ${drawn.map((s) => rangeText(data, s)).join("; ")}. The table below lists every value.`,
    width: WIDTH,
    height: HEIGHT,
    drawing: [`<rect class="frame" x="${LEFT}" y="${TOP}" width="${PLOT_W}" height="${PLOT_H}"/>`, ...grid, ...xTicks, axisName, ...lines].join("\n"),
    table: htmlTable(`${data.title}: ${data.unit} by sample`, columns(data), rows(data).map((r) => r.map(escapeHtml)), { rowHeaders: true }),
    fold: `Table of the ${formatNumber(data.labels.length)} samples`,
    notes: notes.map((n) => `<p class="legend">${escapeHtml(n)}</p>\n`).join(""),
  });
}

export function trendChartMd(data: TrendChartData): string {
  const empty = emptyOf(data);
  if (empty !== undefined) return noticeMd({ level: "notice", text: empty });
  return [`**${escapeMd(data.title)}** (${escapeMd(data.unit)}, oldest first)`, "", mdTable(columns(data), rows(data)), ...(data.note === undefined ? [] : ["", `_${escapeMd(data.note)}_`])].join("\n");
}
