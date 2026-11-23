import { escapeHtml, escapeMd } from "./text.ts";

export type Align = "left" | "right";

export interface TableColumn {
  label: string;
  align?: Align;
}

/** A table whose cells are already html. The first column's cells are row headers when `rowHeaders` is set. */
export function htmlTable(caption: string, columns: TableColumn[], rows: string[][], options: { rowHeaders?: boolean; className?: string } = {}): string {
  const head = columns.map((c) => `<th scope="col"${c.align === "right" ? ' class="number"' : ""}>${escapeHtml(c.label)}</th>`).join("");
  const body = rows
    .map((row) => {
      const cells = row.map((cell, i) => {
        const number = columns[i]?.align === "right" ? ' class="number"' : "";
        return i === 0 && options.rowHeaders === true ? `<th scope="row">${cell}</th>` : `<td${number}>${cell}</td>`;
      });
      return `<tr>${cells.join("")}</tr>`;
    })
    .join("\n");
  return `<table${options.className === undefined ? "" : ` class="${options.className}"`}>\n<caption>${escapeHtml(caption)}</caption>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

/** A GitHub flavoured markdown table. Cells are plain text and are escaped here. */
export function mdTable(columns: TableColumn[], rows: string[][]): string {
  const head = `| ${columns.map((c) => escapeMd(c.label)).join(" | ")} |`;
  const rule = `| ${columns.map((c) => (c.align === "right" ? "---:" : "---")).join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map((cell) => escapeMd(cell)).join(" | ")} |`);
  return [head, rule, ...body].join("\n");
}
