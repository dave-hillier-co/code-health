import { escapeHtml } from "./text.ts";

/**
 * The report pages that sit beside the one being rendered: the report kind, and the title of that page. A page
 * links to a sibling only when the sibling is in this map, so a link never points at a file that is not there.
 */
export type Siblings = ReadonlyMap<string, string>;

/** A link to a place on the same page. */
export const pageHref = (id: string): string => `#${id}`;

/**
 * A link to another report page, as the data carries it: `report:<kind>`, then optionally `?title=<text>` (the link is kept
 * only when the sibling's page title is that text, which tells that the page is about the same file) and `#<id>`. The render
 * turns it into `<kind>.html#<id>`, or drops it when the page is not a sibling.
 */
export function reportHref(kind: string, options: { id?: string; title?: string } = {}): string {
  return `report:${kind}${options.title === undefined ? "" : `?title=${encodeURIComponent(options.title)}`}${options.id === undefined ? "" : `#${options.id}`}`;
}

const REPORT_REF = /^report:([a-z-]+)(?:\?title=([^#]*))?(?:#(.*))?$/;

function resolveOne(href: string, siblings: Siblings | undefined): string | undefined {
  const match = REPORT_REF.exec(href);
  if (match === null) return href;
  const [, kind, title, id] = match;
  const page = siblings?.get(kind!);
  if (page === undefined) return undefined;
  if (title !== undefined && page !== decodeURIComponent(title)) return undefined;
  return `${kind}.html${id === undefined ? "" : `#${id}`}`;
}

const isLinkKey = (key: string) => /href/i.test(key);

function walk(value: unknown, linky: boolean, siblings: Siblings | undefined): unknown {
  if (typeof value === "string") return linky ? (resolveOne(value, siblings) ?? null) : value;
  if (Array.isArray(value)) return value.map((item) => walk(item, linky, siblings));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const inside = linky || isLinkKey(key);
      const resolved = walk(item, inside, siblings);
      if (resolved !== null || !inside) out[key] = resolved;
    }
    return out;
  }
  return value;
}

/**
 * The block with every link resolved for a page: any value under a key that contains "href" (`href`, `rowHrefs`,
 * `cellHrefs`) is a link. A link to another report page becomes a relative file name, or is removed when that page is not
 * among `siblings`; an array of links keeps its positions, with null where a link was removed.
 */
export function resolveLinks<T>(block: T, siblings: Siblings | undefined): T {
  return walk(block, false, siblings) as T;
}

/** The anchor around html that is already escaped, or the html alone when there is no link. */
export function linked(html: string, href: string | null | undefined): string {
  return href === null || href === undefined ? html : `<a href="${escapeHtml(href)}">${html}</a>`;
}
