import { escapeHtml, escapeMd, formatNumber } from "../text.ts";

export type Trend = "stronger" | "stable" | "weaker";

export interface TrendMarkerData {
  /** What the two values measure, such as "support". */
  label: string;
  /** The value in the earlier window and in the later one, and the names of the two windows. */
  earlier: number;
  later: number;
  windows: [string, string];
  /** How far the later value may differ from the earlier one, as a fraction of it, and still be stable. Default 0.2. */
  tolerance?: number;
}

export const ARROW: Record<Trend, string> = { stronger: "↑", stable: "→", weaker: "↓" };

/** Compares a later window with an earlier one. A change within the tolerance, as a fraction of the earlier value, is stable. From 0 any rise is stronger. */
export function trendOf(earlier: number, later: number, tolerance = 0.2): Trend {
  if (later === earlier) return "stable";
  const base = Math.abs(earlier);
  if (base === 0) return later > 0 ? "stronger" : "weaker";
  if (Math.abs(later - earlier) <= tolerance * base) return "stable";
  return later > earlier ? "stronger" : "weaker";
}

function words(data: TrendMarkerData): { trend: Trend; detail: string } {
  const trend = trendOf(data.earlier, data.later, data.tolerance);
  return { trend, detail: `${data.label}: ${formatNumber(data.earlier)} in ${data.windows[0]}, ${formatNumber(data.later)} in ${data.windows[1]}` };
}

/** An inline marker: an arrow and the word, with the two values beside it. The arrow is decoration, the word is the signal. */
export function trendMarkerHtml(data: TrendMarkerData): string {
  const { trend, detail } = words(data);
  return `<span class="trend ${trend}"><span aria-hidden="true">${ARROW[trend]}</span> ${trend} <span class="trend-detail">(${escapeHtml(detail)})</span></span>`;
}

export function trendMarkerMd(data: TrendMarkerData): string {
  const { trend, detail } = words(data);
  return `${ARROW[trend]} ${trend} (${escapeMd(detail)})`;
}
