import { count, escapeHtml, escapeMd, formatNumber } from "../text.ts";
import { htmlTable, mdTable } from "../tables.ts";
import { figureHtml } from "./figure.ts";
import { drawMap, mapOmissions, selectMapItems, tableOrder } from "./treemap.ts";

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
  /** The most tiles drawn, largest first. The rest are counted under the chart. Default: every item is drawn. */
  maxTiles?: number;
  /** The most rows in the table under the chart, largest first. The rest are counted. Default 20. */
  tableRows?: number;
}

const DEFAULT_TABLE_ROWS = 20;

interface Prepared {
  drawn: CategoryTreemapItem[];
  unsized: number;
  beyondLimit: number;
  categoryOf: (item: CategoryTreemapItem) => Category | null;
}

function prepare(data: CategoryTreemapData): Prepared {
  const { drawn, unsized, beyondLimit } = selectMapItems(data.items, data.maxTiles);
  const byId = new Map(data.categories.map((c) => [c.id, c]));
  return { drawn, unsized, beyondLimit, categoryOf: (item) => (item.category === null ? null : (byId.get(item.category) ?? null)) };
}

const rows = (prepared: Prepared, limit: number) => tableOrder(prepared.drawn).slice(0, limit).map((item) => [item.path, formatNumber(item.size), prepared.categoryOf(item)?.label ?? "none"]);
const columns = (data: CategoryTreemapData) => [{ label: "Path" }, { label: `Size (${data.sizeLabel})`, align: "right" as const }, { label: data.categoryLabel }];

type Totals = Map<string, { items: number; size: number }>;

/** How many of the items drawn, and how much size, are of each category, for the legend. */
function drawnPerCategory(prepared: Prepared): Totals {
  const totals: Totals = new Map();
  for (const item of prepared.drawn) {
    const at = totals.get(item.category ?? "") ?? { items: 0, size: 0 };
    totals.set(item.category ?? "", { items: at.items + 1, size: at.size + item.size });
  }
  return totals;
}

const totalText = (data: CategoryTreemapData, totals: { items: number; size: number } | undefined) => `${count(totals?.items ?? 0, "tile")}, ${formatNumber(totals?.size ?? 0)} ${data.sizeLabel}`;

export function categoryTreemapHtml(data: CategoryTreemapData): string {
  const prepared = prepare(data);
  const map = drawMap(
    prepared.drawn.map((item) => {
      const category = prepared.categoryOf(item);
      return {
        path: item.path,
        size: item.size,
        band: category === null ? "none" : String(category.band),
        value: category?.mark ?? "none",
        title: `${item.path}: ${formatNumber(item.size)} ${data.sizeLabel}, ${category === null ? `no ${data.categoryLabel}` : `${data.categoryLabel} ${category.label}`}`,
      };
    }),
  );
  const per = drawnPerCategory(prepared);
  const kind = data.categoryLabel.toLowerCase();
  const legend = data.categories.map((c) => `<li><strong>${escapeHtml(c.mark)}</strong> ${escapeHtml(c.label)}: ${escapeHtml(totalText(data, per.get(c.id)))}</li>`);
  if (per.has("")) legend.push(`<li>hatched, no ${escapeHtml(kind)}: ${escapeHtml(totalText(data, per.get("")))}</li>`);
  const tableRows = data.tableRows ?? DEFAULT_TABLE_ROWS;
  const left = mapOmissions({ beyondLimit: prepared.beyondLimit, unsized: prepared.unsized, tableRows: Math.min(tableRows, prepared.drawn.length), tableTotal: prepared.drawn.length, bare: map.bare, sizeLabel: data.sizeLabel });
  const notes = `<p class="legend">Area is ${escapeHtml(data.sizeLabel)}. Every tile is filled by its ${escapeHtml(kind)}, and a tile large enough prints its name and the mark of its ${escapeHtml(kind)}; hatched tiles have none. The marks, with the tiles and ${escapeHtml(data.sizeLabel)} of each:</p>\n<ul class="legend">\n${legend.join("\n")}\n</ul>\n${left.length === 0 ? "" : `<p class="omitted">${escapeHtml(left.join("; "))}.</p>\n`}`;
  return figureHtml({
    kind: "treemap category-treemap",
    title: data.title,
    description: `A treemap of ${count(prepared.drawn.length, "item")} nested by folder. Area is ${data.sizeLabel}; each tile is filled by its ${kind}. The table below lists ${prepared.drawn.length > tableRows ? `the ${tableRows} largest of them` : "the same items"}.`,
    width: map.width,
    height: map.height,
    drawing: map.drawing,
    table: htmlTable(`${data.title}: ${prepared.drawn.length > tableRows ? "the largest items" : "the items drawn, largest first"}`, columns(data), rows(prepared, tableRows).map((r) => r.map(escapeHtml)), { rowHeaders: true }),
    notes,
  });
}

export function categoryTreemapMd(data: CategoryTreemapData): string {
  const prepared = prepare(data);
  const tableRows = data.tableRows ?? DEFAULT_TABLE_ROWS;
  const left = mapOmissions({ beyondLimit: prepared.beyondLimit, unsized: prepared.unsized, tableRows: Math.min(tableRows, prepared.drawn.length), tableTotal: prepared.drawn.length, bare: { tiles: 0, size: 0 }, sizeLabel: data.sizeLabel });
  const per = drawnPerCategory(prepared);
  const key = [...data.categories.map((c) => `${escapeMd(c.mark)} ${escapeMd(c.label)} (${totalText(data, per.get(c.id))})`), ...(per.has("") ? [`none (${totalText(data, per.get(""))})`] : [])].join("; ");
  return [
    `**${escapeMd(data.title)}** (the items by ${data.sizeLabel}, largest first; marks: ${key})`,
    "",
    mdTable(columns(data), rows(prepared, tableRows)),
    ...(left.length === 0 ? [] : ["", `${left.join("; ")}.`]),
  ].join("\n");
}
