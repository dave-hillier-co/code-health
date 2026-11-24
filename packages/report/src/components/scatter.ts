import { clip, escapeHtml, escapeMd, formatNumber } from "../text.ts";
import { htmlTable, mdTable } from "../tables.ts";
import { figureHtml } from "./figure.ts";
import { noticeHtml, noticeMd } from "./notice.ts";

export interface ScatterPoint {
  /** What the point is, such as a file path. The table prints it whole. */
  label: string;
  /** A shorter text for the drawing, such as the file name. The label when absent. */
  short?: string;
  x: number;
  y: number;
  /** Drawn as a square and, within `maxLabels`, named in the drawing and listed in the table. */
  highlight?: boolean;
}

/** A dashed line at a value of one axis. The value is printed beside the line and the name is in the legend. */
export interface ScatterGuideline {
  value: number;
  /** What the value is, such as "the 75th percentile of revisions (cochange.hotspotPercentile)". */
  name: string;
}

export interface QuadrantNames {
  upperRight: string;
  upperLeft: string;
  lowerRight: string;
  lowerLeft: string;
}

export interface ScatterData {
  title: string;
  xLabel: string;
  yLabel: string;
  /** What a point is, for the counts: "files". */
  noun?: string;
  points: ScatterPoint[];
  /** Log scales, for values with a long tail. A value below 1 is drawn on the axis minimum, 1, and counted in the legend. */
  xLog?: boolean;
  yLog?: boolean;
  /** Guideline lines. With both, the points are counted in four quadrants. */
  xGuideline?: ScatterGuideline;
  yGuideline?: ScatterGuideline;
  quadrantNames?: Partial<QuadrantNames>;
  /** How many highlighted points are named and tabled, in the order of `points`. The rest are drawn as squares without a name. */
  maxLabels?: number;
  /** Replaces the line printed instead of the chart when there is no point. */
  emptyText?: string;
}

export const DEFAULT_MAX_LABELS = 12;

const WIDTH = 680;
const HEIGHT = 440;
const LEFT = 64;
const RIGHT = 20;
const TOP = 12;
const BOTTOM = 56;
const PLOT_W = WIDTH - LEFT - RIGHT;
const PLOT_H = HEIGHT - TOP - BOTTOM;
const CHAR_W = 5.9;
const LABEL_H = 11;
const MAX_NAME = 30;

const DEFAULT_NAMES: QuadrantNames = { upperRight: "upper right", upperLeft: "upper left", lowerRight: "lower right", lowerLeft: "lower left" };
const names = (data: ScatterData): QuadrantNames => ({ ...DEFAULT_NAMES, ...data.quadrantNames });
const noun = (data: ScatterData) => data.noun ?? "points";

type Quadrant = keyof QuadrantNames;

const hasQuadrants = (data: ScatterData) => data.xGuideline !== undefined && data.yGuideline !== undefined;

function quadrantOf(data: ScatterData, point: ScatterPoint): Quadrant {
  const right = point.x >= data.xGuideline!.value;
  const upper = point.y >= data.yGuideline!.value;
  return upper ? (right ? "upperRight" : "upperLeft") : right ? "lowerRight" : "lowerLeft";
}

/** How many points are in each quadrant; a point on a guideline counts on the side at or above it. */
export function quadrantCounts(data: ScatterData): Record<Quadrant, number> {
  const counts: Record<Quadrant, number> = { upperRight: 0, upperLeft: 0, lowerRight: 0, lowerLeft: 0 };
  if (!hasQuadrants(data)) return counts;
  for (const point of data.points) counts[quadrantOf(data, point)]++;
  return counts;
}

/** The highlighted points that are named and tabled, in the order given. */
const labelled = (data: ScatterData) => data.points.filter((p) => p.highlight === true).slice(0, data.maxLabels ?? DEFAULT_MAX_LABELS);
const highlighted = (data: ScatterData) => data.points.filter((p) => p.highlight === true).length;

interface Axis {
  log: boolean;
  ticks: number[];
  /** Position from 0 to 1. */
  at: (value: number) => number;
}

function niceMax(value: number): number {
  const power = 10 ** Math.floor(Math.log10(Math.max(value, 1)));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * power >= value) ?? 10;
  return step * power;
}

function axisOf(values: number[], log: boolean, guideline: number | undefined): Axis {
  const greatest = Math.max(1, ...values, guideline ?? 0);
  if (log) {
    const top = Math.max(1, Math.ceil(Math.log10(greatest)));
    const ticks = Array.from({ length: top + 1 }, (_, i) => 10 ** i);
    return { log, ticks, at: (v) => Math.log10(Math.max(v, 1)) / top };
  }
  const max = niceMax(greatest);
  return { log, ticks: [0, 1, 2, 3, 4].map((i) => (max * i) / 4), at: (v) => Math.max(0, v) / max };
}

interface Box { x: number; y: number; w: number; h: number }
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

interface Placed { text: string; x: number; y: number; anchor: "start" | "end"; byNumber: boolean }

/** Places each label beside its dot at the first of six offsets that stays inside the plot and clear of earlier labels and named dots; a name with no room falls back to its number, and a number with no room is left off. */
function placeLabels(items: { cx: number; cy: number; name: string; number: string }[]): (Placed | null)[] {
  const taken: Box[] = items.map((i) => ({ x: i.cx - 5, y: i.cy - 5, w: 10, h: 10 }));
  const inside = (b: Box) => b.x >= LEFT && b.x + b.w <= WIDTH - RIGHT + 4 && b.y >= TOP && b.y + b.h <= TOP + PLOT_H;
  return items.map((item) => {
    for (const [text, byNumber] of [[item.name, false], [item.number, true]] as const) {
      const w = text.length * CHAR_W;
      const candidates: { box: Box; x: number; y: number; anchor: "start" | "end" }[] = [
        { box: { x: item.cx + 7, y: item.cy - LABEL_H - 1, w, h: LABEL_H }, x: item.cx + 7, y: item.cy - 4, anchor: "start" },
        { box: { x: item.cx + 7, y: item.cy + 1, w, h: LABEL_H }, x: item.cx + 7, y: item.cy + 10, anchor: "start" },
        { box: { x: item.cx - 7 - w, y: item.cy - LABEL_H - 1, w, h: LABEL_H }, x: item.cx - 7, y: item.cy - 4, anchor: "end" },
        { box: { x: item.cx - 7 - w, y: item.cy + 1, w, h: LABEL_H }, x: item.cx - 7, y: item.cy + 10, anchor: "end" },
        { box: { x: item.cx - w / 2, y: item.cy - 8 - LABEL_H, w, h: LABEL_H }, x: item.cx - w / 2, y: item.cy - 9, anchor: "start" },
        { box: { x: item.cx - w / 2, y: item.cy + 8, w, h: LABEL_H }, x: item.cx - w / 2, y: item.cy + 17, anchor: "start" },
      ];
      const fit = candidates.find((c) => inside(c.box) && !taken.some((t) => overlaps(c.box, t)));
      if (fit !== undefined) {
        taken.push(fit.box);
        return { text, x: fit.x, y: fit.y, anchor: fit.anchor, byNumber };
      }
    }
    return null;
  });
}

const tickText = (v: number) => formatNumber(Math.round(v * 100) / 100);

function notes(data: ScatterData): string[] {
  const n = noun(data);
  const out: string[] = [];
  const scales = [data.xLog === true ? `${data.xLabel} (horizontal)` : null, data.yLog === true ? `${data.yLabel} (vertical)` : null].filter((s): s is string => s !== null);
  if (scales.length > 0) out.push(`Log scale on ${scales.join(" and ")}: each tick is ten times the one before, because the values have a long tail.`);
  const below = data.points.filter((p) => (data.xLog === true && p.x < 1) || (data.yLog === true && p.y < 1)).length;
  if (below > 0) out.push(`${formatNumber(below)} ${n} have a value below 1 on a log axis and are drawn on the axis minimum, 1.`);
  const lines = [data.xGuideline === undefined ? null : `vertical dashed line at ${formatNumber(data.xGuideline.value)}: ${data.xGuideline.name}`, data.yGuideline === undefined ? null : `horizontal dashed line at ${formatNumber(data.yGuideline.value)}: ${data.yGuideline.name}`].filter((s): s is string => s !== null);
  if (lines.length > 0) out.push(`Guidelines: ${lines.join("; ")}. A guideline orders and labels results; it decides nothing.`);
  if (hasQuadrants(data)) out.push(quadrantLine(data));
  const total = highlighted(data);
  const listed = labelled(data).length;
  if (total > 0) out.push(`Squares are highlighted ${n}. The table lists ${formatNumber(listed)} of ${formatNumber(total)} highlighted ${n}, in the order given, and the drawing names them; ${formatNumber(total - listed)} are not listed and are drawn as squares without a name.`);
  return out;
}

function quadrantLine(data: ScatterData): string {
  const q = quadrantCounts(data);
  const nm = names(data);
  return `Of ${formatNumber(data.points.length)} ${noun(data)}: ${(["upperRight", "upperLeft", "lowerRight", "lowerLeft"] as const).map((k) => `${formatNumber(q[k])} ${nm[k]}`).join(", ")}.`;
}

const columns = (data: ScatterData) => [
  { label: "#", align: "right" as const },
  { label: "Point" },
  { label: data.xLabel, align: "right" as const },
  { label: data.yLabel, align: "right" as const },
  ...(hasQuadrants(data) ? [{ label: "Quadrant" }] : []),
];

function rows(data: ScatterData): string[][] {
  const nm = names(data);
  return labelled(data).map((p, i) => [String(i + 1), p.label, formatNumber(p.x), formatNumber(p.y), ...(hasQuadrants(data) ? [nm[quadrantOf(data, p)]] : [])]);
}

const emptyOf = (data: ScatterData) => (data.points.length === 0 ? (data.emptyText ?? `${data.title}: no ${noun(data)} to draw.`) : undefined);

export function scatterHtml(data: ScatterData): string {
  const empty = emptyOf(data);
  if (empty !== undefined) return noticeHtml({ level: "notice", text: empty });
  const ax = axisOf(data.points.map((p) => p.x), data.xLog === true, data.xGuideline?.value);
  const ay = axisOf(data.points.map((p) => p.y), data.yLog === true, data.yGuideline?.value);
  const px = (v: number) => LEFT + ax.at(v) * PLOT_W;
  const py = (v: number) => TOP + (1 - ay.at(v)) * PLOT_H;
  const at = (v: number) => v.toFixed(1);
  const frame = `<rect class="frame" x="${LEFT}" y="${TOP}" width="${PLOT_W}" height="${PLOT_H}"/>`;
  const ticks = [
    ...ax.ticks.map((v) => `<text class="tick" x="${at(px(v))}" y="${TOP + PLOT_H + 16}" text-anchor="middle">${tickText(v)}</text>`),
    ...ay.ticks.map((v) => `<text class="tick" x="${LEFT - 8}" y="${at(py(v) + 4)}" text-anchor="end">${tickText(v)}</text>`),
  ];
  const axisNames = [
    `<text class="axis" x="${at(LEFT + PLOT_W / 2)}" y="${HEIGHT - 8}" text-anchor="middle">${escapeHtml(data.xLabel)}${data.xLog === true ? " (log scale)" : ""}</text>`,
    `<text class="axis" transform="rotate(-90 14 ${at(TOP + PLOT_H / 2)})" x="14" y="${at(TOP + PLOT_H / 2)}" text-anchor="middle">${escapeHtml(data.yLabel)}${data.yLog === true ? " (log scale)" : ""}</text>`,
  ];
  const lines = [
    ...(data.xGuideline === undefined ? [] : [`<g class="guideline"><line x1="${at(px(data.xGuideline.value))}" y1="${TOP}" x2="${at(px(data.xGuideline.value))}" y2="${TOP + PLOT_H}"><title>${escapeHtml(data.xGuideline.name)}</title></line><text x="${at(px(data.xGuideline.value) + 3)}" y="${TOP + PLOT_H - 4}">${formatNumber(data.xGuideline.value)}</text></g>`]),
    ...(data.yGuideline === undefined ? [] : [`<g class="guideline"><line x1="${LEFT}" y1="${at(py(data.yGuideline.value))}" x2="${LEFT + PLOT_W}" y2="${at(py(data.yGuideline.value))}"><title>${escapeHtml(data.yGuideline.name)}</title></line><text x="${LEFT + PLOT_W - 3}" y="${at(py(data.yGuideline.value) - 3)}" text-anchor="end">${formatNumber(data.yGuideline.value)}</text></g>`]),
  ];
  const named = labelled(data);
  const dots = data.points
    .filter((p) => !named.includes(p))
    .map((p) => (p.highlight === true ? `<rect class="point highlight" x="${at(px(p.x) - 2.5)}" y="${at(py(p.y) - 2.5)}" width="5" height="5"/>` : `<circle class="point" cx="${at(px(p.x))}" cy="${at(py(p.y))}" r="2.2"/>`));
  const placed = placeLabels(named.map((p, i) => ({ cx: px(p.x), cy: py(p.y), name: clip(p.short ?? p.label, MAX_NAME), number: String(i + 1) })));
  const marks = named.map((p, i) => {
    const label = placed[i];
    const text = label === null || label === undefined ? "" : `<text class="name" x="${at(label.x)}" y="${at(label.y)}" text-anchor="${label.anchor}">${escapeHtml(label.text)}</text>`;
    return `<g class="point named"><title>${escapeHtml(`${i + 1}. ${p.label}: ${formatNumber(p.x)} ${data.xLabel}, ${formatNumber(p.y)} ${data.yLabel}`)}</title><rect x="${at(px(p.x) - 4)}" y="${at(py(p.y) - 4)}" width="8" height="8"/>${text}</g>`;
  });
  const byNumber = placed.filter((p) => p?.byNumber === true).length;
  const unplaced = placed.filter((p) => p === null).length;
  const extra = [
    ...(byNumber > 0 ? [`${formatNumber(byNumber)} named ${noun(data)} have no free room for their name and print their table number instead.`] : []),
    ...(unplaced > 0 ? [`${formatNumber(unplaced)} named ${noun(data)} have no free room for a name or number; the table gives them.`] : []),
  ];
  const description = `A scatter of ${formatNumber(data.points.length)} ${noun(data)}: ${data.xLabel} horizontal, ${data.yLabel} vertical${data.xLog === true || data.yLog === true ? ", on log scales" : ""}${hasQuadrants(data) ? `, split into four quadrants by dashed guideline lines. ${quadrantLine(data)}` : "."} The table below lists the ${formatNumber(named.length)} named points with their values.`;
  return figureHtml({
    kind: "scatter",
    title: data.title,
    description,
    width: WIDTH,
    height: HEIGHT,
    drawing: [frame, ...lines, ...ticks, ...axisNames, ...dots, ...marks].join("\n"),
    table: htmlTable(`${data.title}: the named points`, columns(data), rows(data).map((r) => r.map(escapeHtml)), { rowHeaders: false }),
    notes: [...notes(data), ...extra].map((n) => `<p class="legend">${escapeHtml(n)}</p>\n`).join(""),
  });
}

export function scatterMd(data: ScatterData): string {
  const empty = emptyOf(data);
  if (empty !== undefined) return noticeMd({ level: "notice", text: empty });
  const body = rows(data);
  return [
    `**${escapeMd(data.title)}** (${escapeMd(data.xLabel)} against ${escapeMd(data.yLabel)})`,
    "",
    ...(body.length === 0 ? [] : [mdTable(columns(data), body.map((r) => r.map((cell, i) => (i === 1 ? clip(cell, 80) : cell)))), ""]),
    notes(data).map((n) => `_${escapeMd(n)}_`).join("\n\n"),
  ].join("\n");
}
