import { escapeHtml, escapeMd } from "../text.ts";
import { htmlTable, mdTable } from "../tables.ts";

export interface Fact {
  label: string;
  value: string;
}

export interface FactsData {
  caption: string;
  facts: Fact[];
}

const columns = [{ label: "Measure" }, { label: "Value" }];

export function factsHtml(data: FactsData): string {
  return htmlTable(data.caption, columns, data.facts.map((f) => [escapeHtml(f.label), escapeHtml(f.value)]), { rowHeaders: true, className: "facts" });
}

export function factsMd(data: FactsData): string {
  return [`**${escapeMd(data.caption)}**`, "", mdTable(columns, data.facts.map((f) => [f.label, f.value]))].join("\n");
}
