import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The report kinds of the suite, each written to `<kind>.html` by default. A page links to another only by these names,
 * so a link always uses the name the file has when the reports are written with `--out FOLDER/<kind>.html`.
 */
export const SUITE_REPORT_KINDS = ["overview", "hotspots", "coupling", "knowledge", "change", "structure", "locality", "xray"] as const;

const unescapeHtml = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/**
 * The report pages that sit in the same folder as `out`, for the links of the page written there: the kind and the page
 * title of each `<kind>.html` that exists, is not `ownKind`, and was written for `commit` (its footer names the commit), so a
 * link never leads to a page from another commit. Empty without `out`: a page printed to the terminal has no folder.
 */
export function readSiblings(out: string | undefined, ownKind: string, commit: string): Map<string, string> {
  const pages = new Map<string, string>();
  if (out === undefined) return pages;
  const folder = dirname(out);
  for (const kind of SUITE_REPORT_KINDS) {
    if (kind === ownKind) continue;
    const file = join(folder, `${kind}.html`);
    if (!existsSync(file)) continue;
    let html: string;
    try {
      html = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!html.includes(`for commit <code>${commit.slice(0, 12)}</code>`)) continue;
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
    if (title !== undefined) pages.set(kind, unescapeHtml(title));
  }
  return pages;
}
