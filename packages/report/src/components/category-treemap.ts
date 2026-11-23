import { clip, count, escapeHtml, escapeMd, formatNumber } from "../text.ts";
import { htmlTable, mdTable } from "../tables.ts";
import { figureHtml } from "./figure.ts";
import { layoutTreemap, type TreemapItem } from "./treemap.ts";

/** One kind of item. Its `band` (1 to 5) picks the fill from the page's five band colours, and the label is printed in each tile. */
export interface Category {
  id: string;
  /** The words the legend, the tiles' titles and the table use. */
  label: string;
  /** A short mark printed in the tile beside the name, so the kind never rests on colour alone. */
  mark: string;
  band: number;
}

export interface CategoryTreemapItem {
  /** Repo-relative path. Folders nest the tiles. */
  path: string;
  /** Decides the tile's area. Items of no size are not drawn. */
  size: number;
  /** A category id, or null for an item of no category: it is drawn hatched and marked "none". */
  category: string | null;
}

/** A treemap whose tiles are coloured by kind rather than by a value on a scale. */
export interface CategoryTreemapData {
  title: string;
  /** What the sizes are, such as "lines held by people". */
  sizeLabel: string;
  /** What the kinds are, such as "knowledge-risk pattern". */
  categoryLabel: string;
  categories: Category[];
  items: CategoryTreemapItem[];
  /** The most tiles drawn, largest first. The rest are counted under the chart. Default 80. */
  maxTiles?: number;
}

const WIDTH = 960;
const HEIGHT = 520;
const DEFAULT_MAX_TILES = 80;
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface Prepared {
  drawn: CategoryTreemapItem[];
  unsized: number;
  beyondLimit: number;
  categoryOf: (item: CategoryTreemapItem) => Category | null;
}

function prepare(data: CategoryTreemapData): Prepared {
  const sized = data.items.filter((item) => item.size > 0).sort((a, b) => b.size - a.size || byName(a.path, b.path));
  const drawn = sized.slice(0, data.maxTiles ?? DEFAULT_MAX_TILES);
  const byId = new Map(data.categories.map((c) => [c.id, c]));
  return { drawn, unsized: data.items.length - sized.length, beyondLimit: sized.length - drawn.length, categoryOf: (item) => (item.category === null ? null : (byId.get(item.category) ?? null)) };
}

function omissions(prepared: Prepared): string[] {
  const out: string[] = [];
  if (prepared.beyondLimit > 0) out.push(`${count(prepared.beyondLimit, "smaller item")} not drawn`);
  if (prepared.unsized > 0) out.push(`${count(prepared.unsized, "item")} of no size not drawn`);
  return out;
}

const rows = (prepared: Prepared) => prepared.drawn.map((item) => [item.path, formatNumber(item.size), prepared.categoryOf(item)?.label ?? "none"]);
const columns = (data: CategoryTreemapData) => [{ label: "Path" }, { label: `Size (${data.sizeLabel})`, align: "right" as const }, { label: data.categoryLabel }];

/** How many of the items drawn are of each category, for the legend. */
function drawnPerCategory(prepared: Prepared): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of prepared.drawn) counts.set(item.category ?? "", (counts.get(item.category ?? "") ?? 0) + 1);
  return counts;
}

export function categoryTreemapHtml(data: CategoryTreemapData): string {
  const prepared = prepare(data);
  const items: TreemapItem[] = prepared.drawn.map((item) => ({ path: item.path, size: item.size, colour: null }));
  const byPath = new Map(prepared.drawn.map((item) => [item.path, item]));
  const { tiles, folders } = layoutTreemap(items);
  const fmt = (n: number) => n.toFixed(1);
  const drawing = [
    ...folders.map((f) => `<g class="folder"><rect x="${fmt(f.x)}" y="${fmt(f.y)}" width="${fmt(f.w)}" height="${fmt(f.h)}"/>${f.w > 40 && f.h > 28 ? `<text x="${fmt(f.x + 4)}" y="${fmt(f.y + 11)}">${escapeHtml(clip(f.name, Math.floor((f.w - 8) / 6.2)))}</text>` : ""}</g>`),
    ...tiles.map((t) => {
      const item = byPath.get(t.path)!;
      const category = prepared.categoryOf(item);
      const room = Math.floor((t.w - 6) / 6.2);
      const labels = t.w >= 36 && t.h >= 16 ? [`<text x="${fmt(t.x + 3)}" y="${fmt(t.y + 12)}">${escapeHtml(clip(t.name, room))}</text>`] : [];
      if (t.w >= 36 && t.h >= 30) labels.push(`<text x="${fmt(t.x + 3)}" y="${fmt(t.y + 25)}">${escapeHtml(clip(category?.mark ?? "none", room))}</text>`);
      return `<g class="tile band-${category === null ? "none" : category.band}"><title>${escapeHtml(`${t.path}: ${formatNumber(item.size)} ${data.sizeLabel}, ${category === null ? `no ${data.categoryLabel}` : `${data.categoryLabel} ${category.label}`}`)}</title><rect x="${fmt(t.x)}" y="${fmt(t.y)}" width="${fmt(t.w)}" height="${fmt(t.h)}"/>${labels.join("")}</g>`;
    }),
  ].join("\n");
  const per = drawnPerCategory(prepared);
  const legend = data.categories.map((c) => `<li><strong>${escapeHtml(c.mark)}</strong> ${escapeHtml(c.label)}: ${count(per.get(c.id) ?? 0, "tile")}</li>`).join("\n");
  const left = omissions(prepared);
  const notes = `<p class="legend">Area is ${escapeHtml(data.sizeLabel)}. Each tile prints its name and the mark of its ${escapeHtml(data.categoryLabel.toLowerCase())}; hatched tiles have none. The marks are:</p>\n<ul class="legend">\n${legend}\n</ul>\n${left.length === 0 ? "" : `<p class="omitted">${escapeHtml(left.join("; "))}.</p>\n`}`;
  return figureHtml({
    kind: "treemap category-treemap",
    title: data.title,
    description: `A treemap of ${count(prepared.drawn.length, "item")} nested by folder. Area is ${data.sizeLabel}; each tile is marked with its ${data.categoryLabel.toLowerCase()}. The table below lists the same items.`,
    width: WIDTH,
    height: HEIGHT,
    drawing,
    table: htmlTable(`${data.title}: the items drawn, largest first`, columns(data), rows(prepared).map((r) => r.map(escapeHtml)), { rowHeaders: true }),
    notes,
  });
}

export function categoryTreemapMd(data: CategoryTreemapData): string {
  const prepared = prepare(data);
  const left = omissions(prepared);
  const per = drawnPerCategory(prepared);
  const key = data.categories.map((c) => `${escapeMd(c.mark)} ${escapeMd(c.label)} (${count(per.get(c.id) ?? 0, "tile")})`).join("; ");
  return [
    `**${escapeMd(data.title)}** (the items by ${data.sizeLabel}, largest first; marks: ${key})`,
    "",
    mdTable(columns(data), rows(prepared)),
    ...(left.length === 0 ? [] : ["", `${left.join("; ")}.`]),
  ].join("\n");
}
