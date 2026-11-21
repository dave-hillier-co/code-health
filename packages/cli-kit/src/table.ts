import { roundFloat } from "./serialise.ts";
import type { Truncation } from "./results.ts";

/** Plain aligned text for people on a TTY. Numbers are right aligned. */
export function renderTable(rows: Record<string, unknown>[], columns: string[], truncated: Truncation): string {
  if (rows.length === 0) return "No results.\n";

  const cells = rows.map((row) => columns.map((column) => format(row[column])));
  const numeric = columns.map((column) => rows.every((row) => row[column] == null || typeof row[column] === "number"));
  const widths = columns.map((column, i) => Math.max(column.length, ...cells.map((line) => line[i]?.length ?? 0)));

  const render = (line: string[]) =>
    line
      .map((cell, i) => (numeric[i] ? cell.padStart(widths[i] ?? 0) : cell.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();

  const lines = [render(columns), ...cells.map(render)];
  if (truncated.cut > 0) lines.push(`${truncated.cut} more not shown (use --limit N or --limit all)`);
  return lines.join("\n") + "\n";
}

function format(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "number") return String(roundFloat(value));
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
