import { clip, count, escapeHtml, escapeMd, formatNumber } from "../text.ts";
import { htmlTable, mdTable } from "../tables.ts";
import { bandLegend, makeBands, type Bands } from "./bands.ts";
import { figureHtml } from "./figure.ts";

export interface TreemapItem {
  /** Repo-relative path. Folders nest the tiles. */
  path: string;
  /** Decides the tile's area. Items of no size are not drawn. */
  size: number;
  /** Decides the tile's band. null draws the tile hatched and marks it "none". */
  colour: number | null;
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
  /** The most tiles drawn, largest first. The rest are counted under the chart. Default 80. */
  maxTiles?: number;
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
const DEFAULT_MAX_TILES = 80;

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

/** The tiles and folder boxes of a layout: folders nest their children, and each level is ordered largest first, then by name. */
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
      const header = r.h > HEADER * 2 && r.w > 40 ? HEADER : 0;
      place(child, { x: r.x + PAD, y: r.y + PAD + header, w: Math.max(0, r.w - PAD * 2), h: Math.max(0, r.h - PAD * 2 - header) });
    });
  };
  place(buildTree(items), { x: 0, y: 0, w: width, h: height });
  return { tiles, folders };
}

interface Prepared {
  drawn: TreemapItem[];
  notDrawn: { unsized: number; beyondLimit: number };
  bands: Bands;
}

function prepare(data: TreemapData): Prepared {
  const sized = data.items.filter((item) => item.size > 0).sort((a, b) => b.size - a.size || byName(a.path, b.path));
  const limit = data.maxTiles ?? DEFAULT_MAX_TILES;
  const drawn = sized.slice(0, limit);
  const coloured = drawn.flatMap((item) => (item.colour === null ? [] : [item.colour]));
  return { drawn, notDrawn: { unsized: data.items.length - sized.length, beyondLimit: sized.length - drawn.length }, bands: makeBands(coloured, data.breaks) };
}

const bandName = (item: TreemapItem, bands: Bands) => (item.colour === null ? "none" : String(bands.of(item.colour)));

function omissions(prepared: Prepared): string[] {
  const out: string[] = [];
  if (prepared.notDrawn.beyondLimit > 0) out.push(`${count(prepared.notDrawn.beyondLimit, "smaller item")} not drawn`);
  if (prepared.notDrawn.unsized > 0) out.push(`${count(prepared.notDrawn.unsized, "item")} of no size not drawn`);
  return out;
}

const rows = (prepared: Prepared) => prepared.drawn.map((item) => [item.path, formatNumber(item.size), item.colour === null ? "none" : formatNumber(item.colour), bandName(item, prepared.bands)]);

function columns(data: TreemapData) {
  return [{ label: "Path" }, { label: `Size (${data.sizeLabel})`, align: "right" as const }, { label: `Colour (${data.colourLabel})`, align: "right" as const }, { label: "Band", align: "right" as const }];
}

export function treemapHtml(data: TreemapData): string {
  const prepared = prepare(data);
  const { tiles, folders } = layoutTreemap(prepared.drawn);
  const fmt = (n: number) => n.toFixed(1);
  const drawing = [
    ...folders.map((f) => `<g class="folder"><rect x="${fmt(f.x)}" y="${fmt(f.y)}" width="${fmt(f.w)}" height="${fmt(f.h)}"/>${f.w > 40 && f.h > HEADER * 2 ? `<text x="${fmt(f.x + 4)}" y="${fmt(f.y + 11)}">${escapeHtml(clip(f.name, Math.floor((f.w - 8) / 6.2)))}</text>` : ""}</g>`),
    ...tiles.map((t) => {
      const room = Math.floor((t.w - 6) / 6.2);
      const labels = t.w >= 36 && t.h >= 16 ? [`<text x="${fmt(t.x + 3)}" y="${fmt(t.y + 12)}">${escapeHtml(clip(t.name, room))}</text>`] : [];
      if (t.w >= 36 && t.h >= 30) labels.push(`<text x="${fmt(t.x + 3)}" y="${fmt(t.y + 25)}">${escapeHtml(clip(t.item.colour === null ? "none" : formatNumber(t.item.colour), room))}</text>`);
      return `<g class="tile band-${bandName(t.item, prepared.bands)}"><title>${escapeHtml(`${t.path}: ${formatNumber(t.item.size)} ${data.sizeLabel}, ${t.item.colour === null ? "no" : formatNumber(t.item.colour)} ${data.colourLabel}`)}</title><rect x="${fmt(t.x)}" y="${fmt(t.y)}" width="${fmt(t.w)}" height="${fmt(t.h)}"/>${labels.join("")}</g>`;
    }),
  ].join("\n");
  const left = omissions(prepared);
  const notes = `<p class="legend">Area is ${escapeHtml(data.sizeLabel)}. Colour is ${escapeHtml(data.colourLabel)} in five bands, and each tile prints its value: ${escapeHtml(bandLegend(prepared.bands))}. Hatched tiles have no value.</p>\n${left.length === 0 ? "" : `<p class="omitted">${escapeHtml(left.join("; "))}.</p>\n`}`;
  return figureHtml({
    kind: "treemap",
    title: data.title,
    description: `A treemap of ${count(prepared.drawn.length, "item")} nested by folder. Area is ${data.sizeLabel}; colour is ${data.colourLabel}. The table below lists the same items.`,
    width: WIDTH,
    height: HEIGHT,
    drawing,
    table: htmlTable(`${data.title}: the items drawn, largest first`, columns(data), rows(prepared).map((r) => r.map(escapeHtml)), { rowHeaders: true }),
    notes,
  });
}

export function treemapMd(data: TreemapData): string {
  const prepared = prepare(data);
  const left = omissions(prepared);
  return [
    `**${escapeMd(data.title)}** (the items by ${data.sizeLabel}, largest first; band is ${data.colourLabel}, ${bandLegend(prepared.bands)})`,
    "",
    mdTable(columns(data), rows(prepared)),
    ...(left.length === 0 ? [] : ["", `${left.join("; ")}.`]),
  ].join("\n");
}
