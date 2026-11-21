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

/** Sorts list results by score then path, cuts to the limit, and projects fields. */
export function shapeResults(results: unknown, options: ShapeOptions): { results: unknown; truncated: Truncation } {
  if (!Array.isArray(results)) return { results, truncated: { limit: null, total: null, cut: 0 } };

  const { limit, fields, columns } = options;
  if (fields && columns) {
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

function byScoreThenPath(a: Row, b: Row): number {
  const scoreA = typeof a.score === "number" ? a.score : 0;
  const scoreB = typeof b.score === "number" ? b.score : 0;
  if (scoreA !== scoreB) return scoreB - scoreA;
  const pathA = String(a.path ?? "");
  const pathB = String(b.path ?? "");
  return pathA < pathB ? -1 : pathA > pathB ? 1 : 0;
}
