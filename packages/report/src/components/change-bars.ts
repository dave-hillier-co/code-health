import { clip, escapeHtml, escapeMd, formatNumber } from "../text.ts";
import { htmlTable, mdTable } from "../tables.ts";
import { linked } from "../links.ts";
import { figureHtml } from "./figure.ts";
import { noticeHtml, noticeMd } from "./notice.ts";

export interface ChangeBar {
  /** What changed, such as a folder. */
  label: string;
  /** The value before and after. The bar is their difference. */
  from: number;
  to: number;
  /** Links the label and its table row to where the item is described. Html only. */
  href?: string;
}

export interface ChangeBarsData {
  title: string;
  /** What the values measure: "import distance". */
  unit: string;
  /** The names of the two samples compared: the earlier and the later. */
  samples: [string, string];
  /** One bar each, in the order given: the chart does not sort. */
  bars: ChangeBar[];
  /** The words for a bar to the right of zero and one to the left. Default "rose" and "fell". */
  wording?: { rise: string; fall: string };
  /** A sentence printed under the chart. */
  note?: string;
  /** Replaces the line printed instead of the chart when there are no bars. */
  emptyText?: string;
}

const WIDTH = 760;
const LABEL_W = 250;
const VALUE_W = 64;
const ROW = 22;
const TOP = 22;
const BOTTOM = 8;
const MAX_LABEL = 40;

const words = (data: ChangeBarsData) => data.wording ?? { rise: "rose", fall: "fell" };
const changeOf = (bar: ChangeBar) => bar.to - bar.from;
const signed = (value: number) => (value > 0 ? `+${formatNumber(value)}` : formatNumber(value));
const wordOf = (data: ChangeBarsData, bar: ChangeBar) => (changeOf(bar) > 0 ? words(data).rise : changeOf(bar) < 0 ? words(data).fall : "no change");

const emptyOf = (data: ChangeBarsData) => (data.bars.length === 0 ? (data.emptyText ?? `${data.title}: nothing changed.`) : undefined);

const columns = (data: ChangeBarsData) => [
  { label: "Item" },
  { label: `${data.unit}, ${data.samples[0]}`, align: "right" as const },
  { label: `${data.unit}, ${data.samples[1]}`, align: "right" as const },
  { label: "Change", align: "right" as const },
  { label: "Direction" },
];
const rows = (data: ChangeBarsData) => data.bars.map((bar) => [bar.label, formatNumber(bar.from), formatNumber(bar.to), signed(changeOf(bar)), wordOf(data, bar)]);

export function changeBarsHtml(data: ChangeBarsData): string {
  const empty = emptyOf(data);
  if (empty !== undefined) return noticeHtml({ level: "notice", text: empty });
  const greatestFall = Math.max(0, ...data.bars.map((bar) => -changeOf(bar)));
  const greatestRise = Math.max(0, ...data.bars.map((bar) => changeOf(bar)));
  const fallen = greatestFall > 0;
  const risen = greatestRise > 0;
  // One scale for both directions, and the zero line placed so that the longest bar each way just fits.
  const plotLeft = LABEL_W + VALUE_W;
  const plotRight = WIDTH - VALUE_W;
  const scale = (plotRight - plotLeft) / Math.max(1e-9, greatestFall + greatestRise);
  const zero = plotLeft + greatestFall * scale;
  const height = TOP + data.bars.length * ROW + BOTTOM;
  const at = (v: number) => v.toFixed(1);
  const { rise, fall } = words(data);
  const heads = [
    ...(fallen ? [`<text class="axis" x="${at(zero - 6)}" y="13" text-anchor="end">${escapeHtml(fall)}</text>`] : []),
    ...(risen ? [`<text class="axis" x="${at(zero + 6)}" y="13">${escapeHtml(rise)}</text>`] : []),
  ];
  const bars = data.bars.map((bar, i) => {
    const change = changeOf(bar);
    const y = TOP + i * ROW;
    const length = Math.abs(change) * scale;
    const x = change < 0 ? zero - length : zero;
    const label = linked(`<text class="name" x="${LABEL_W - 8}" y="${y + 15}" text-anchor="end">${escapeHtml(clip(bar.label, MAX_LABEL))}</text>`, bar.href);
    const value = `<text class="value" x="${at(change < 0 ? x - 4 : x + length + 4)}" y="${y + 15}" text-anchor="${change < 0 ? "end" : "start"}">${escapeHtml(signed(change))}</text>`;
    return `<g class="change ${change > 0 ? "rise" : change < 0 ? "fall" : "level"}"><title>${escapeHtml(`${bar.label}: ${formatNumber(bar.from)} to ${formatNumber(bar.to)}, ${wordOf(data, bar)}${change === 0 ? "" : ` by ${formatNumber(Math.abs(change))}`}`)}</title>${label}<rect x="${at(x)}" y="${y + 4}" width="${at(Math.max(length, 1))}" height="${ROW - 8}"/>${value}</g>`;
  });
  const counts = [`${formatNumber(data.bars.filter((b) => changeOf(b) > 0).length)} ${rise}`, `${formatNumber(data.bars.filter((b) => changeOf(b) < 0).length)} ${fall}`];
  const notes = [`Each bar is the value at ${data.samples[1]} minus the value at ${data.samples[0]}. A bar to the right of the line: ${rise}. A bar to the left: ${fall}. The direction is in the words and the sign, not in the colour alone.`, ...(data.note === undefined ? [] : [data.note])];
  return figureHtml({
    kind: "change-bars",
    title: data.title,
    description: `Horizontal bars of the change in ${data.unit} from ${data.samples[0]} to ${data.samples[1]} for ${formatNumber(data.bars.length)} items: ${counts.join(", ")}. The table below lists both values and the change for each.`,
    width: WIDTH,
    height,
    drawing: [...heads, `<line class="zero" x1="${at(zero)}" y1="${TOP - 4}" x2="${at(zero)}" y2="${height - BOTTOM + 2}"/>`, ...bars].join("\n"),
    table: htmlTable(`${data.title}: ${data.unit} at the two samples`, columns(data), rows(data).map((r, k) => r.map((c, i) => (i === 0 ? linked(escapeHtml(c), data.bars[k]?.href) : escapeHtml(c)))), { rowHeaders: true }),
    fold: `Table of the ${formatNumber(data.bars.length)} items`,
    notes: notes.map((n) => `<p class="legend">${escapeHtml(n)}</p>\n`).join(""),
  });
}

export function changeBarsMd(data: ChangeBarsData): string {
  const empty = emptyOf(data);
  if (empty !== undefined) return noticeMd({ level: "notice", text: empty });
  return [`**${escapeMd(data.title)}** (${escapeMd(data.unit)}, ${escapeMd(data.samples[0])} to ${escapeMd(data.samples[1])})`, "", mdTable(columns(data), rows(data)), ...(data.note === undefined ? [] : ["", `_${escapeMd(data.note)}_`])].join("\n");
}
