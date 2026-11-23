import { clip, escapeHtml, escapeMd, formatNumber } from "../text.ts";
import { htmlTable, mdTable } from "../tables.ts";
import { figureHtml } from "./figure.ts";
import { noticeHtml, noticeMd } from "./notice.ts";

export interface StabilityPoint {
  name: string;
  /** Martin's I, 0 to 1. */
  instability: number;
  /** Martin's A, 0 to 1. */
  abstractness: number;
  /** Distance from the main sequence, `|A + I - 1|`. */
  distance: number;
  ca: number;
  ce: number;
  exportedTypes: number;
  /** Too few exported types for A to say much. */
  weak: boolean;
}

export interface StabilityChartData {
  title: string;
  /** Distance from the main sequence at which a zone starts: a guideline that labels and decides nothing. */
  zoneDistance: number;
  /** Where the zone distance comes from, shown in the legend. */
  zoneSource?: string;
  /** Every measured point, in the order to number them. All are drawn; the first `maxPoints` are numbered and in the table, and the others are small points counted by position in the legend. */
  points: StabilityPoint[];
  maxPoints?: number;
  /** The packages there are, before the cut and the ones that have no figures. */
  total: number;
  /** What the packages are, for the counts: "packages". */
  noun?: string;
  /** Replaces the line printed instead of the chart when it has fewer than `MIN_POINTS` points. */
  emptyText?: string;
}

export const DEFAULT_MAX_POINTS = 40;
/** A scatter of fewer points says nothing a table does not, so the chart prints a notice instead. */
export const MIN_POINTS = 3;

/** The one-line notice that replaces a chart of fewer than three points, or undefined when the chart is drawn. */
export function stabilityChartEmpty(data: StabilityChartData): string | undefined {
  if (data.points.length >= MIN_POINTS) return undefined;
  const noun = data.noun ?? "packages";
  return data.emptyText ?? `${data.title}: ${formatNumber(data.points.length)} of ${formatNumber(data.total)} ${noun} have both instability and abstractness; a chart needs at least ${MIN_POINTS}.`;
}

export type Position = "zone of pain" | "zone of uselessness" | "outside the zones";

/** Where a point sits: in the corner where the sum of A and I is at most `1 - zoneDistance` (concrete and stable), or at least `1 + zoneDistance` (abstract and unstable). */
export function positionOf(point: Pick<StabilityPoint, "instability" | "abstractness">, zoneDistance: number): Position {
  const sum = point.instability + point.abstractness;
  if (sum <= 1 - zoneDistance) return "zone of pain";
  if (sum >= 1 + zoneDistance) return "zone of uselessness";
  return "outside the zones";
}

const SIZE = 360;
const LEFT = 56;
const TOP = 16;
const WIDTH = LEFT + SIZE + 24;
const HEIGHT = TOP + SIZE + 48;

const x = (instability: number) => LEFT + instability * SIZE;
const y = (abstractness: number) => TOP + (1 - abstractness) * SIZE;
const at = (value: number) => value.toFixed(1);

const shown = (data: StabilityChartData) => data.points.slice(0, data.maxPoints ?? DEFAULT_MAX_POINTS);

const columns = [
  { label: "#", align: "right" as const },
  { label: "Package" },
  { label: "Instability I", align: "right" as const },
  { label: "Abstractness A", align: "right" as const },
  { label: "Distance", align: "right" as const },
  { label: "Ca", align: "right" as const },
  { label: "Ce", align: "right" as const },
  { label: "Exported types", align: "right" as const },
  { label: "Position" },
];

function rows(data: StabilityChartData): string[][] {
  return shown(data).map((p, i) => [
    String(i + 1),
    p.name,
    formatNumber(p.instability),
    formatNumber(p.abstractness),
    formatNumber(p.distance),
    formatNumber(p.ca),
    formatNumber(p.ce),
    `${formatNumber(p.exportedTypes)}${p.weak ? " (A weak)" : ""}`,
    positionOf(p, data.zoneDistance),
  ]);
}

/** How many of the measured points sit in each position. */
export function positionCounts(data: StabilityChartData): Record<Position, number> {
  const counts: Record<Position, number> = { "zone of pain": 0, "zone of uselessness": 0, "outside the zones": 0 };
  for (const point of data.points) counts[positionOf(point, data.zoneDistance)]++;
  return counts;
}

function notes(data: StabilityChartData): string[] {
  const noun = data.noun ?? "packages";
  const left = data.total - shown(data).length;
  const unplotted = data.total - data.points.length;
  const cut = data.points.length - shown(data).length;
  const why = unplotted > 0 ? `${formatNumber(unplotted)} have no instability (no dependency in or out) or no abstractness (no language adapter reads them)` : "";
  const drawn = cut > 0 ? `${formatNumber(cut)} are measured and drawn as small points without a number` : "";
  const counts = positionCounts(data);
  return [
    `The dashed diagonal is the main sequence, where A + I = 1. A zone starts ${formatNumber(data.zoneDistance)} from it${data.zoneSource === undefined ? "" : ` (${data.zoneSource})`}: the zone of pain is concrete and stable (A + I at most ${formatNumber(1 - data.zoneDistance)}) and the zone of uselessness is abstract and unstable (A + I at least ${formatNumber(1 + data.zoneDistance)}). Square points are inside a zone, round points are not, and the table gives each position in words. A guideline orders and labels results; it decides nothing.`,
    `Of the ${formatNumber(data.points.length)} measured ${noun}, ${formatNumber(counts["zone of pain"])} are in the zone of pain, ${formatNumber(counts["zone of uselessness"])} in the zone of uselessness and ${formatNumber(counts["outside the zones"])} outside the zones.`,
    `The table lists ${formatNumber(shown(data).length)} of ${formatNumber(data.total)} ${noun}, furthest from the main sequence first; ${formatNumber(left)} not listed${left > 0 ? `: ${[why, drawn].filter((s) => s !== "").join("; ")}` : ""}.`,
  ];
}

export function stabilityChartHtml(data: StabilityChartData): string {
  const empty = stabilityChartEmpty(data);
  if (empty !== undefined) return noticeHtml({ level: "notice", text: empty });
  const d = data.zoneDistance;
  const points = data.points;
  const limit = shown(data).length;
  const frame = `<rect x="${LEFT}" y="${TOP}" width="${SIZE}" height="${SIZE}" fill="none" stroke="currentColor" stroke-opacity="0.5"/>`;
  const pain = `<polygon points="${at(x(0))},${at(y(0))} ${at(x(1 - d))},${at(y(0))} ${at(x(0))},${at(y(1 - d))}" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.5" stroke-dasharray="3 3"/>`;
  const useless = `<polygon points="${at(x(1))},${at(y(1))} ${at(x(d))},${at(y(1))} ${at(x(1))},${at(y(d))}" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.5" stroke-dasharray="3 3"/>`;
  const sequence = `<line x1="${at(x(0))}" y1="${at(y(1))}" x2="${at(x(1))}" y2="${at(y(0))}" stroke="currentColor" stroke-width="1.5" stroke-dasharray="6 4"/>`;
  const labels = [
    `<text x="${at(x(0) + 6)}" y="${at(y(0) - 8)}">Zone of pain</text>`,
    `<text x="${at(x(1) - 6)}" y="${at(y(1) + 16)}" text-anchor="end">Zone of uselessness</text>`,
    `<text x="${at(x(0.5) + 6)}" y="${at(y(0.5) - 6)}" transform="rotate(45 ${at(x(0.5))} ${at(y(0.5))})" text-anchor="middle">Main sequence</text>`,
  ];
  const ticks = [0, 0.5, 1].flatMap((v) => [
    `<text x="${at(x(v))}" y="${TOP + SIZE + 16}" text-anchor="middle">${v}</text>`,
    `<text x="${LEFT - 8}" y="${at(y(v) + 4)}" text-anchor="end">${v}</text>`,
  ]);
  const axes = [
    `<text x="${at(x(0.5))}" y="${TOP + SIZE + 36}" text-anchor="middle">Instability I (outgoing over all dependencies)</text>`,
    `<text transform="rotate(-90 14 ${at(y(0.5))})" x="14" y="${at(y(0.5))}" text-anchor="middle">Abstractness A</text>`,
  ];
  const dots = points.map((p, i) => {
    const cx = x(p.instability);
    const cy = y(p.abstractness);
    const inside = positionOf(p, d) !== "outside the zones";
    const numbered = i < limit;
    const half = numbered ? 4 : 2.5;
    const mark = inside ? `<rect x="${at(cx - half)}" y="${at(cy - half)}" width="${half * 2}" height="${half * 2}" fill="currentColor"/>` : `<circle cx="${at(cx)}" cy="${at(cy)}" r="${half}"/>`;
    return `<g class="point">${mark}${numbered ? `<text x="${at(cx + 7)}" y="${at(cy - 5)}">${i + 1}</text>` : ""}</g>`;
  });
  return figureHtml({
    kind: "stability-chart",
    title: data.title,
    description: `A scatter of ${formatNumber(points.length)} ${data.noun ?? "packages"} by instability (horizontal) and abstractness (vertical), with the main sequence and the zone of pain and the zone of uselessness marked. The ${formatNumber(limit)} furthest from the main sequence have a number that the table below gives with their figures and their position in words; the legend counts all of them by position.`,
    width: WIDTH,
    height: HEIGHT,
    drawing: [pain, useless, frame, sequence, ...labels, ...ticks, ...axes, ...dots].join("\n"),
    table: htmlTable(`${data.title}: the same points with their figures`, columns, rows(data).map((r) => r.map(escapeHtml)), { rowHeaders: false }),
    notes: notes(data)
      .map((n) => `<p class="legend">${escapeHtml(n)}</p>\n`)
      .join(""),
  });
}

export function stabilityChartMd(data: StabilityChartData): string {
  const empty = stabilityChartEmpty(data);
  if (empty !== undefined) return noticeMd({ level: "notice", text: empty });
  return [`**${escapeMd(data.title)}** (instability I against abstractness A)`, "", mdTable(columns, rows(data).map((r) => r.map((cell, i) => (i === 1 ? clip(cell, 80) : cell)))), "", notes(data).map((n) => `_${escapeMd(n)}_`).join("\n\n")].join("\n");
}
