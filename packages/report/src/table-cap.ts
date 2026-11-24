import type { RankedTableData } from "./components/ranked-table.ts";

/**
 * Cuts a ranked table to its first `max` rows and records what was left out, so the page prints "N of M shown;
 * the rest are in `<command>` output." The command is the one whose output lists every row, for example
 * `cochange hotspots --top 500`. A table with `max` rows or fewer is returned unchanged. A table that was already
 * cut by its builder (`total` above `rows.length`) keeps that total.
 */
export function capRows(table: RankedTableData, max: number, command: string): RankedTableData {
  const total = Math.max(table.total ?? table.rows.length, table.rows.length);
  if (table.rows.length <= max && total === table.rows.length) return table;
  return {
    ...table,
    rows: table.rows.slice(0, max),
    ...(table.rowIds === undefined ? {} : { rowIds: table.rowIds.slice(0, max) }),
    ...(table.cellHrefs === undefined ? {} : { cellHrefs: table.cellHrefs.slice(0, max) }),
    total,
    fullIn: command,
  };
}
