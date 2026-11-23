import { createHash } from "node:crypto";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Text on one line: runs of whitespace, newlines included, become a single space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const MD_SPECIAL = /[\\|*<>[\]]/g;

/**
 * Markdown for text that is not meant as markup: the characters that start emphasis, links, tables and html are
 * escaped. A `code span` in the text stays one, so a command named in a notice reads as code; text with an
 * unbalanced backtick has every backtick escaped.
 */
export function escapeMd(text: string): string {
  const line = oneLine(text);
  const balanced = (line.match(/`/g) ?? []).length % 2 === 0;
  if (!balanced) return line.replace(/[\\|*`<>[\]]/g, (c) => `\\${c}`);
  return line
    .split("`")
    .map((part, i) => (i % 2 === 1 ? part.replace(/\|/g, "\\|") : part.replace(MD_SPECIAL, (c) => `\\${c}`)))
    .join("`");
}

/** Html for fixed report text: escaped, with a `code span` shown as code. */
export function inlineHtml(text: string): string {
  const escaped = escapeHtml(text);
  return (escaped.match(/`/g) ?? []).length % 2 === 0 ? escaped.replace(/`([^`]+)`/g, "<code>$1</code>") : escaped;
}

/** A number as the pages print it: whole numbers plain, others to at most two places, thousands not separated. */
export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(2)));
}

/** A short stable token for a piece of content, to keep element ids unique within a page. */
export function shortHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 6);
}

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

/** `n` with its noun, `1 file` and `2 files`. */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(n)} ${n === 1 ? singular : plural}`;
}

/** The text cut to `max` characters with an ellipsis, for labels inside drawings. */
export function clip(text: string, max: number): string {
  if (max < 1) return "";
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
