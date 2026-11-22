import { usageError } from "./errors.ts";

export interface Truncation {
  /** The limit that applied, or null when unlimited or the results are not a list. */
  limit: number | null;
  /** Rows before cutting, or null when the results are not a list. */
  total: number | null;
  cut: number;
}

export interface ShapeOptions {
  limit: number;
  fields?: string[];
  /** Valid field names. When given, unknown fields are rejected. */
  columns?: string[];
}

type Row = Record<string, unknown>;

/** Sorts list results by ranking ratio (when a row has one), then score, then path, cuts to the limit, and projects fields. */
export function shapeResults(results: unknown, options: ShapeOptions): { results: unknown; truncated: Truncation } {
  if (!Array.isArray(results)) return { results, truncated: { limit: null, total: null, cut: 0 } };

  const { limit, fields, columns } = options;
  if (fields && columns && columns.length > 0) {
    const unknown = fields.filter((field) => !columns.includes(field));
    if (unknown.length > 0) {
      throw usageError(`unknown field ${unknown.join(", ")}; valid fields: ${columns.join(", ")}`);
    }
  }

  const sorted = [...(results as Row[])].sort(byScoreThenPath);
  const kept = sorted.slice(0, limit);
  const projected = fields ? kept.map((row) => Object.fromEntries(fields.map((field) => [field, row[field]]))) : kept;
  return {
    results: projected,
    truncated: {
      limit: Number.isFinite(limit) ? limit : null,
      total: sorted.length,
      cut: sorted.length - kept.length,
    },
  };
}

/** How far past its guideline a row is: `ranking.ratio`, or 0 for a row without one, which then sorts by score alone. */
function ratioOf(row: Row): number {
  const ranking = row.ranking;
  if (typeof ranking !== "object" || ranking === null) return 0;
  const ratio = (ranking as Row).ratio;
  return typeof ratio === "number" ? ratio : 0;
}

function byScoreThenPath(a: Row, b: Row): number {
  const ratioA = ratioOf(a);
  const ratioB = ratioOf(b);
  if (ratioA !== ratioB) return ratioB - ratioA;
  const scoreA = typeof a.score === "number" ? a.score : 0;
  const scoreB = typeof b.score === "number" ? b.score : 0;
  if (scoreA !== scoreB) return scoreB - scoreA;
  // UTF-8 byte order, which is how git orders paths; UTF-16 code unit order differs above the BMP.
  return Buffer.compare(Buffer.from(String(a.path ?? "")), Buffer.from(String(b.path ?? "")));
}
