import { clip, count, escapeHtml, escapeMd, formatNumber } from "../text.ts";
import { htmlTable, mdTable } from "../tables.ts";
import { bandCountText, bandLegend, makeBands, type Bands } from "./bands.ts";
import { figureHtml } from "./figure.ts";

export interface TreemapItem {
  /** Repo-relative path. Folders nest the tiles. */
  path: string;
  /** Decides the tile's area. Items of no size are not drawn. */
  size: number;
  /** Decides the tile's band. null draws the tile grey and marks it "none". */
  colour: number | null;
  /** A short mark, such as a rank. A marked tile is outlined and prints the mark before its name, and the table lists it first. */
  mark?: string;
}

export interface TreemapData {
  title: string;
  /** What the sizes are, such as "lines" or "revisions". Chosen by the caller. */
  sizeLabel: string;
  /** What the colours are, such as "cognitive complexity". Chosen by the caller. */
  colourLabel: string;
  items: TreemapItem[];
  /** Four ascending values that split the bands. Without them the colour range splits into five equal steps. */
  breaks?: number[];
  /** The most tiles drawn, largest first. The rest are counted under the chart. Default: every item is drawn. */
  maxTiles?: number;
  /** The most rows in the table under the chart: the marked items, then the largest. The rest are counted. Default 20. */
  tableRows?: number;
  /** Words for what the marks mean, printed in the legend, such as "files of the friction list". */
  markLabel?: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Tile extends Rect {
  path: string;
  name: string;
  item: TreemapItem;
}

export interface FolderBox extends Rect {
  path: string;
  name: string;
}

const WIDTH = 960;
const HEIGHT = 520;
const HEADER = 14;
const PAD = 2;

interface Node {
  name: string;
  path: string;
  size: number;
  item?: TreemapItem;
  children: Node[];
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function buildTree(items: readonly TreemapItem[]): Node {
  const root: Node = { name: "", path: "", size: 0, children: [] };
  for (const item of items) {
    let at = root;
    const parts = item.path.split("/");
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let next = at.children.find((child) => child.name === part && (i < parts.length - 1) === (child.item === undefined));
      if (next === undefined) {
        next = { name: part, path, size: 0, children: [] };
        at.children.push(next);
      }
      if (i === parts.length - 1) next.item = item;
      at = next;
    });
  }
  const total = (node: Node): number => {
    node.size = node.item !== undefined ? node.item.size : node.children.reduce((sum, child) => sum + total(child), 0);
    return node.size;
  };
  total(root);
  // A folder holding only one folder shows as one box named by the whole chain, which saves a header per level.
  const collapse = (node: Node): void => {
    for (const child of node.children) {
      while (child.item === undefined && child.children.length === 1 && child.children[0]!.item === undefined) {
        const only = child.children[0]!;
        child.name = `${child.name}/${only.name}`;
        child.path = only.path;
        child.children = only.children;
      }
      collapse(child);
    }
  };
  collapse(root);
  return root;
}

/** Bruls, Huizing and van Wijk's squarified layout of `sizes` (largest first) inside `rect`. Returns one rect per size, in order. */
export function squarify(sizes: readonly number[], rect: Rect): Rect[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const out: Rect[] = [];
  if (total <= 0) return sizes.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }));
  const scale = (rect.w * rect.h) / total;
  const areas = sizes.map((size) => size * scale);
  let { x, y, w, h } = rect;
  let start = 0;
  const worst = (row: readonly number[], side: number): number => {
    const sum = row.reduce((a, b) => a + b, 0);
    const largest = Math.max(...row);
    const smallest = Math.min(...row);
    return Math.max((side * side * largest) / (sum * sum), (sum * sum) / (side * side * smallest));
  };
  while (start < areas.length) {
    const side = Math.min(w, h);
    let end = start + 1;
    while (end < areas.length && worst(areas.slice(start, end + 1), side) <= worst(areas.slice(start, end), side)) end++;
    const row = areas.slice(start, end);
    const sum = row.reduce((a, b) => a + b, 0);
    if (w >= h) {
      // The row is a column at the left, as wide as its area needs and as tall as what is left.
      const width = h === 0 ? 0 : sum / h;
      let top = y;
      for (const area of row) {
        const height = width === 0 ? 0 : area / width;
        out.push({ x, y: top, w: width, h: height });
        top += height;
      }
      x += width;
      w -= width;
    } else {
      const height = w === 0 ? 0 : sum / w;
      let left = x;
      for (const area of row) {
        const width = height === 0 ? 0 : area / height;
        out.push({ x: left, y, w: width, h: height });
        left += width;
      }
      y += height;
      h -= height;
    }
    start = end;
  }
  return out;
}

/** Padding inside a folder box: none in a box too small to show it, so thousands of small folders keep their area. */
function paddingOf(r: Rect): number {
  const least = Math.min(r.w, r.h);
  return least < 12 ? 0 : least < 40 ? 1 : PAD;
}

/** The tiles and folder boxes of a layout: folders nest their children, and each level is ordered largest first, then by name. The same items always give the same layout, so two maps of one item set put every tile in the same place. */
export function layoutTreemap(items: readonly TreemapItem[], width = WIDTH, height = HEIGHT): { tiles: Tile[]; folders: FolderBox[] } {
  const tiles: Tile[] = [];
  const folders: FolderBox[] = [];
  const place = (node: Node, rect: Rect): void => {
    const children = [...node.children].sort((a, b) => b.size - a.size || byName(a.name, b.name));
    const rects = squarify(children.map((c) => c.size), rect);
    children.forEach((child, i) => {
      const r = rects[i]!;
      if (child.item !== undefined) {
        tiles.push({ ...r, path: child.path, name: child.name, item: child.item });
        return;
      }
      folders.push({ ...r, path: child.path, name: child.name });
      const pad = paddingOf(r);
      const header = r.h > HEADER * 2 && r.w > 40 ? HEADER : 0;
      place(child, { x: r.x + pad, y: r.y + pad + header, w: Math.max(0, r.w - pad * 2), h: Math.max(0, r.h - pad * 2 - header) });
    });
  };
  place(buildTree(items), { x: 0, y: 0, w: width, h: height });
  return { tiles, folders };
}

/** A tile to draw: what the layout needs and what each component says about it. */
export interface MapItem {
  path: string;
  size: number;
  /** The class of its fill: `band-1` to `band-5` for a value, `cat-1` to `cat-6` for a kind, or `band-none`. */
  band: string;
  /** The second line of a tile large enough for two. */
  value: string;
  /** The tooltip. */
  title: string;
  mark?: string;
}

/** A tile with less area than this (in svg units squared) is drawn as a bare rectangle, with no name and no tooltip. */
const BARE_AREA = 100;
/** A folder box smaller than this on a side is not outlined; its tiles are still drawn. */
const OUTLINE_SIDE = 8;
const CHAR = 6.2;

/** What the drawing holds, so the notes can say how much of it is bare. */
export interface MapDrawing {
  drawing: string;
  /** Tiles drawn without a name or tooltip, and the size they hold. */
  bare: { tiles: number; size: number };
  width: number;
  height: number;
}

/**
 * The svg inside a code map: folder boxes, then the tiles. Tiles large enough print their name and value (a marked
 * tile prints its mark first, and is outlined however small it is). Smaller tiles are bare rectangles grouped by
 * band, which keeps a map of thousands of files to a size a page can hold. Every item is drawn.
 */
export function drawMap(items: readonly MapItem[]): MapDrawing {
  const byPath = new Map(items.map((item) => [item.path, item]));
  const { tiles, folders } = layoutTreemap(items.map((item) => ({ path: item.path, size: item.size, colour: null })));
  const fmt = (n: number) => n.toFixed(1);
  const out: string[] = [];
  for (const f of folders) {
    if (f.w < OUTLINE_SIDE || f.h < OUTLINE_SIDE) continue;
    const label = f.w > 40 && f.h > HEADER * 2 ? `<text x="${fmt(f.x + 4)}" y="${fmt(f.y + 11)}">${escapeHtml(clip(f.name, Math.floor((f.w - 8) / CHAR)))}</text>` : "";
    out.push(`<g class="folder"><rect x="${fmt(f.x)}" y="${fmt(f.y)}" width="${fmt(f.w)}" height="${fmt(f.h)}"/>${label}</g>`);
  }
  const bare = new Map<string, string[]>();
  let bareTiles = 0;
  let bareSize = 0;
  for (const t of tiles) {
    const item = byPath.get(t.path)!;
    const rect = `<rect x="${fmt(t.x)}" y="${fmt(t.y)}" width="${fmt(t.w)}" height="${fmt(t.h)}"/>`;
    if (item.mark === undefined && t.w * t.h < BARE_AREA) {
      bare.set(item.band, [...(bare.get(item.band) ?? []), rect]);
      bareTiles++;
      bareSize += item.size;
      continue;
    }
    const room = Math.floor((t.w - 6) / CHAR);
    const markText = item.mark === undefined ? "" : `${item.mark} `;
    const first = t.w >= 36 && t.h >= 16 ? clip(`${markText}${t.name}`, room) : item.mark !== undefined && t.w >= 14 && t.h >= 14 ? clip(item.mark, Math.floor((t.w - 4) / CHAR)) : "";
    const labels = first === "" ? [] : [`<text x="${fmt(t.x + 3)}" y="${fmt(t.y + 12)}">${escapeHtml(first)}</text>`];
    if (t.w >= 36 && t.h >= 30 && item.value !== "") labels.push(`<text x="${fmt(t.x + 3)}" y="${fmt(t.y + 25)}">${escapeHtml(clip(item.value, room))}</text>`);
    out.push(`<g class="tile ${item.band}${item.mark === undefined ? "" : " marked"}"><title>${escapeHtml(item.title)}</title>${rect}${labels.join("")}</g>`);
  }
  for (const band of [...bare.keys()].sort()) out.push(`<g class="tile bare ${band}">${bare.get(band)!.join("")}</g>`);
  return { drawing: out.join("\n"), bare: { tiles: bareTiles, size: bareSize }, width: WIDTH, height: HEIGHT };
}

/** The items of a map set in the order of its table: marked ones first, in the order given, then the largest. */
export function tableOrder<T extends { path: string; size: number; mark?: string }>(items: readonly T[]): T[] {
  const marked = items.filter((item) => item.mark !== undefined);
  const rest = items.filter((item) => item.mark === undefined).sort((a, b) => b.size - a.size || byName(a.path, b.path));
  return [...marked, ...rest];
}

/** The items to draw, largest first, and the counts of what a map leaves out. */
export function selectMapItems<T extends { path: string; size: number }>(all: readonly T[], maxTiles: number | undefined): { drawn: T[]; unsized: number; beyondLimit: number } {
  const sized = all.filter((item) => item.size > 0).sort((a, b) => b.size - a.size || byName(a.path, b.path));
  const drawn = maxTiles === undefined ? sized : sized.slice(0, maxTiles);
  return { drawn, unsized: all.length - sized.length, beyondLimit: sized.length - drawn.length };
}

/** The sentences under a map that count what the table and the drawing leave out. */
export function mapOmissions(parts: { beyondLimit: number; unsized: number; tableRows: number; tableTotal: number; bare: MapDrawing["bare"]; sizeLabel: string }): string[] {
  const out: string[] = [];
  if (parts.beyondLimit > 0) out.push(`${count(parts.beyondLimit, "smaller item")} not drawn`);
  if (parts.unsized > 0) out.push(`${count(parts.unsized, "item")} of no size not drawn`);
  if (parts.bare.tiles > 0) out.push(`${count(parts.bare.tiles, "tile")} holding ${formatNumber(parts.bare.size)} ${parts.sizeLabel} too small for a name or tooltip are drawn as bare rectangles`);
  if (parts.tableTotal > parts.tableRows) out.push(`the table lists ${parts.tableRows} of the ${formatNumber(parts.tableTotal)} items drawn (the marked ones, then the largest), and the other ${formatNumber(parts.tableTotal - parts.tableRows)} are on the map only`);
  return out;
}

interface Prepared {
  drawn: TreemapItem[];
  notDrawn: { unsized: number; beyondLimit: number };
  bands: Bands;
}

function prepare(data: TreemapData): Prepared {
  const { drawn, unsized, beyondLimit } = selectMapItems(data.items, data.maxTiles);
  const coloured = drawn.flatMap((item) => (item.colour === null ? [] : [item.colour]));
  return { drawn, notDrawn: { unsized, beyondLimit }, bands: makeBands(coloured, data.breaks) };
}

const bandName = (item: TreemapItem, bands: Bands) => (item.colour === null ? "none" : String(bands.of(item.colour)));

const rowsOf = (prepared: Prepared, limit: number) => tableOrder(prepared.drawn).slice(0, limit).map((item) => [`${item.mark === undefined ? "" : `${item.mark} `}${item.path}`, formatNumber(item.size), item.colour === null ? "none" : formatNumber(item.colour), bandName(item, prepared.bands)]);

function columns(data: TreemapData) {
  return [{ label: "Path" }, { label: `Size (${data.sizeLabel})`, align: "right" as const }, { label: `Colour (${data.colourLabel})`, align: "right" as const }, { label: "Band", align: "right" as const }];
}

const DEFAULT_TABLE_ROWS = 20;

/** How many items and how much size each band holds, for the legend. */
function perBand(prepared: Prepared): { band: string; items: number; size: number }[] {
  const totals = new Map<string, { items: number; size: number }>();
  for (const item of prepared.drawn) {
    const key = bandName(item, prepared.bands);
    const at = totals.get(key) ?? { items: 0, size: 0 };
    totals.set(key, { items: at.items + 1, size: at.size + item.size });
  }
  return [...totals.keys()].sort().map((band) => ({ band, ...totals.get(band)! }));
}

export function treemapHtml(data: TreemapData): string {
  const prepared = prepare(data);
  const marked = prepared.drawn.filter((item) => item.mark !== undefined).length;
  const map = drawMap(
    prepared.drawn.map((item) => ({
      path: item.path,
      size: item.size,
      band: `band-${bandName(item, prepared.bands)}`,
      value: item.colour === null ? "" : formatNumber(item.colour),
      title: `${item.mark === undefined ? "" : `${item.mark} `}${item.path}: ${formatNumber(item.size)} ${data.sizeLabel}, ${item.colour === null ? "no" : formatNumber(item.colour)} ${data.colourLabel}`,
      ...(item.mark === undefined ? {} : { mark: item.mark }),
    })),
  );
  const tableRows = data.tableRows ?? DEFAULT_TABLE_ROWS;
  const left = mapOmissions({ ...prepared.notDrawn, tableRows: Math.min(tableRows, prepared.drawn.length), tableTotal: prepared.drawn.length, bare: map.bare, sizeLabel: data.sizeLabel });
  const bands = perBand(prepared).map((b) => `<li>${b.band === "none" ? "grey, no value" : `band ${escapeHtml(b.band)}`}: ${count(b.items, "item")}, ${formatNumber(b.size)} ${escapeHtml(data.sizeLabel)}</li>`).join("\n");
  const markNote = marked === 0 ? "" : ` Outlined tiles are ${escapeHtml(data.markLabel ?? "marked items")} (${marked}), and each prints its mark.`;
  const notes = `<p class="legend">Area is ${escapeHtml(data.sizeLabel)}. Colour is ${escapeHtml(data.colourLabel)} in ${bandCountText(prepared.bands)}, and a tile large enough prints its value: ${escapeHtml(bandLegend(prepared.bands))}. Grey tiles have no value.${markNote} The items and ${escapeHtml(data.sizeLabel)} in each band:</p>\n<ul class="legend">\n${bands}\n</ul>\n${left.length === 0 ? "" : `<p class="omitted">${escapeHtml(left.join("; "))}.</p>\n`}`;
  return figureHtml({
    kind: "treemap",
    title: data.title,
    description: `A treemap of ${count(prepared.drawn.length, "item")} nested by folder. Area is ${data.sizeLabel}; colour is ${data.colourLabel}. The table below lists ${prepared.drawn.length > tableRows ? `${tableRows} of them` : "the same items"}.`,
    width: map.width,
    height: map.height,
    drawing: map.drawing,
    table: htmlTable(`${data.title}: ${prepared.drawn.length > tableRows ? "the marked items, then the largest" : "the items drawn, marked first, then largest first"}`, columns(data), rowsOf(prepared, tableRows).map((r) => r.map(escapeHtml)), { rowHeaders: true }),
    notes,
  });
}

export function treemapMd(data: TreemapData): string {
  const prepared = prepare(data);
  const tableRows = data.tableRows ?? DEFAULT_TABLE_ROWS;
  const left = mapOmissions({ ...prepared.notDrawn, tableRows: Math.min(tableRows, prepared.drawn.length), tableTotal: prepared.drawn.length, bare: { tiles: 0, size: 0 }, sizeLabel: data.sizeLabel });
  const bands = perBand(prepared).map((b) => `${b.band === "none" ? "no value" : `band ${b.band}`}: ${count(b.items, "item")}, ${formatNumber(b.size)} ${data.sizeLabel}`).join("; ");
  return [
    `**${escapeMd(data.title)}** (the items by ${data.sizeLabel}, marked first, then largest first; band is ${data.colourLabel}, ${bandLegend(prepared.bands)}; ${bands})`,
    "",
    mdTable(columns(data), rowsOf(prepared, tableRows)),
    ...(left.length === 0 ? [] : ["", `${left.join("; ")}.`]),
  ].join("\n");
}
