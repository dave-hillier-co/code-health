import { escapeHtml, escapeMd, formatNumber } from "../text.ts";
import { htmlTable, mdTable } from "../tables.ts";
import { figureHtml } from "./figure.ts";

export interface HistogramBin {
  /** The range or class the bin counts, such as "1 to 5". */
  label: string;
  count: number;
}

export interface HistogramData {
  title: string;
  /** What is counted, such as "files". */
  unit: string;
  bins: HistogramBin[];
}

const WIDTH = 640;
const ROW = 22;
const LABEL = 150;
const BAR_MAX = 400;

const columns = (data: HistogramData) => [{ label: "Bin" }, { label: `Count (${data.unit})`, align: "right" as const }, { label: "Share", align: "right" as const }];

function shares(data: HistogramData): string[] {
  const total = data.bins.reduce((sum, bin) => sum + bin.count, 0);
  return data.bins.map((bin) => (total === 0 ? "0%" : `${formatNumber((bin.count / total) * 100)}%`));
}

const rows = (data: HistogramData) => {
  const share = shares(data);
  return data.bins.map((bin, i) => [bin.label, formatNumber(bin.count), share[i]!]);
};

export function histogramHtml(data: HistogramData): string {
  const greatest = Math.max(1, ...data.bins.map((bin) => bin.count));
  const drawing = data.bins
    .map((bin, i) => {
      const y = i * ROW;
      const width = (bin.count / greatest) * BAR_MAX;
      return `<g class="bin"><text x="${LABEL - 6}" y="${y + 15}" text-anchor="end">${escapeHtml(bin.label)}</text><rect x="${LABEL}" y="${y + 3}" width="${width.toFixed(1)}" height="${ROW - 6}"/><text x="${(LABEL + width + 6).toFixed(1)}" y="${y + 15}">${formatNumber(bin.count)}</text></g>`;
    })
    .join("\n");
  const total = data.bins.reduce((sum, bin) => sum + bin.count, 0);
  return figureHtml({
    kind: "histogram",
    title: data.title,
    description: `${formatNumber(total)} ${data.unit} in ${data.bins.length} bins. Each bar prints its count; the table below lists the same counts.`,
    width: WIDTH,
    height: Math.max(ROW, data.bins.length * ROW),
    drawing,
    table: htmlTable(`${data.title}: ${data.unit} per bin`, columns(data), rows(data).map((r) => r.map(escapeHtml)), { rowHeaders: true }),
  });
}

export function histogramMd(data: HistogramData): string {
  return [`**${escapeMd(data.title)}** (${escapeMd(data.unit)} per bin)`, "", mdTable(columns(data), rows(data))].join("\n");
}
