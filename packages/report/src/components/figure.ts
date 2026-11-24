import { escapeHtml, shortHash, slug } from "../text.ts";

export interface FigureParts {
  /** Taxonomy class beside `chart`: treemap, histogram. */
  kind: string;
  title: string;
  /** What the drawing shows, for assistive technology. */
  description: string;
  width: number;
  height: number;
  /** The inside of the svg. */
  drawing: string;
  /** The text table of the same data, already html. */
  table: string;
  /** Text after the table, already html: the legend and counts of what the drawing leaves out. */
  notes?: string;
  /** Puts the table inside a closed disclosure with this summary, for a chart whose table is long and repeats what the drawing shows. The table stays in the page. */
  fold?: string;
}

/** A chart as a figure: a titled svg, then the table of the same data, then the notes. Ids come from the title and content, so they stay unique on a page. */
export function figureHtml(parts: FigureParts): string {
  const id = `${slug(parts.title)}-${shortHash(parts.drawing)}`;
  const svg = `<svg role="img" aria-labelledby="${id}-title ${id}-desc" width="${parts.width}" height="${parts.height}" viewBox="0 0 ${parts.width} ${parts.height}" preserveAspectRatio="xMinYMin meet">\n<title id="${id}-title">${escapeHtml(parts.title)}</title>\n<desc id="${id}-desc">${escapeHtml(parts.description)}</desc>\n${parts.drawing}\n</svg>`;
  return `<figure class="chart ${parts.kind}">\n<figcaption>${escapeHtml(parts.title)}</figcaption>\n${svg}\n${parts.fold === undefined ? parts.table : `<details>\n<summary>${escapeHtml(parts.fold)}</summary>\n${parts.table}\n</details>`}\n${parts.notes ?? ""}</figure>`;
}
