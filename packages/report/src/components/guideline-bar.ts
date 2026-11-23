import { escapeHtml, escapeMd, formatNumber } from "../text.ts";
import { htmlTable, mdTable } from "../tables.ts";
import { figureHtml } from "./figure.ts";

export interface GuidelineBar {
  label: string;
  value: number;
  guideline: number;
}

export interface GuidelineBarsData {
  title: string;
  /** What the values are, such as "cognitive complexity". */
  unit: string;
  /** Where the guidelines come from, shown under the chart. */
  source?: string;
  bars: GuidelineBar[];
}

const WIDTH = 720;
const ROW = 28;
const LABEL = 200;
const BAR_MAX = 360;

/** Where a value sits against its guideline, as words: the pages never colour it as good or bad. */
export function positionOf(bar: GuidelineBar): "above guideline" | "at guideline" | "below guideline" {
  return bar.value > bar.guideline ? "above guideline" : bar.value === bar.guideline ? "at guideline" : "below guideline";
}

/** The value as a multiple of its guideline, or null when the guideline is 0. */
export function ratioOf(bar: GuidelineBar): number | null {
  return bar.guideline === 0 ? null : bar.value / bar.guideline;
}

const ratioText = (bar: GuidelineBar) => {
  const ratio = ratioOf(bar);
  return ratio === null ? "none" : `${Number(ratio.toPrecision(2))}x`;
};

const columns = (data: GuidelineBarsData) => [{ label: "Item" }, { label: data.unit, align: "right" as const }, { label: "Guideline", align: "right" as const }, { label: "Ratio", align: "right" as const }, { label: "Position" }];
const rows = (data: GuidelineBarsData) => data.bars.map((b) => [b.label, formatNumber(b.value), formatNumber(b.guideline), ratioText(b), positionOf(b)]);

export function guidelineBarsHtml(data: GuidelineBarsData): string {
  const greatest = Math.max(1, ...data.bars.flatMap((b) => [b.value, b.guideline]));
  const scale = BAR_MAX / greatest;
  const drawing = data.bars
    .map((b, i) => {
      const y = i * ROW;
      const width = b.value * scale;
      const marker = LABEL + b.guideline * scale;
      const above = b.value > b.guideline;
      return `<g class="bar ${above ? "above" : "within"}"><text x="${LABEL - 6}" y="${y + 18}" text-anchor="end">${escapeHtml(b.label)}</text><rect x="${LABEL}" y="${y + 5}" width="${width.toFixed(1)}" height="${ROW - 10}"/><line x1="${marker.toFixed(1)}" x2="${marker.toFixed(1)}" y1="${y + 2}" y2="${y + ROW - 2}"/><text x="${(LABEL + Math.max(width, b.guideline * scale) + 8).toFixed(1)}" y="${y + 18}">${above ? "▲ " : ""}${formatNumber(b.value)} (guideline ${formatNumber(b.guideline)})</text></g>`;
    })
    .join("\n");
  return figureHtml({
    kind: "guideline-bars",
    title: data.title,
    description: `${data.bars.length} values of ${data.unit}, each against its guideline. A bar longer than its marker is above guideline, shown with a triangle and the words in the table.`,
    width: WIDTH,
    height: Math.max(ROW, data.bars.length * ROW),
    drawing,
    table: htmlTable(`${data.title}: each value against its guideline`, columns(data), rows(data).map((r) => r.map(escapeHtml)), { rowHeaders: true }),
    notes: `<p class="legend">The vertical line marks the guideline and ▲ marks a value above it. A guideline orders and labels results; it decides nothing.${data.source === undefined ? "" : ` ${escapeHtml(data.source)}`}</p>\n`,
  });
}

export function guidelineBarsMd(data: GuidelineBarsData): string {
  return [`**${escapeMd(data.title)}** (${escapeMd(data.unit)}, each against its guideline${data.source === undefined ? "" : `. ${escapeMd(data.source)}`})`, "", mdTable(columns(data), rows(data))].join("\n");
}
