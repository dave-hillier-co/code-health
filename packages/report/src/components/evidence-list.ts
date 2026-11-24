import { linked } from "../links.ts";
import { escapeHtml, escapeMd, formatNumber } from "../text.ts";

export interface EvidenceItem {
  /** A short commit SHA, a finding id or a path. */
  id: string;
  text: string;
  /** Anything that places it: a date, a file, an author where the plugin allows names. A link stays plain text. */
  detail?: string;
  /** Links the id to where the item is described, on this page or another report page. Html only. */
  href?: string;
}

export interface EvidenceListData {
  title: string;
  items: EvidenceItem[];
  /** How many more there are than the items listed, so the list never hides them silently. */
  omitted?: number;
  /** What an empty list prints. Default "None.". */
  emptyText?: string;
}

const tail = (data: EvidenceListData) => (data.omitted === undefined || data.omitted <= 0 ? undefined : `${formatNumber(data.omitted)} more not listed.`);

export function evidenceListHtml(data: EvidenceListData): string {
  const items = data.items.map((item) => `<li>${linked(`<code>${escapeHtml(item.id)}</code>`, item.href)} ${escapeHtml(item.text)}${item.detail === undefined ? "" : ` <span class="detail">(${escapeHtml(item.detail)})</span>`}</li>`);
  const more = tail(data);
  return `<section class="evidence">\n<h3>${escapeHtml(data.title)}</h3>\n${items.length === 0 ? `<p class="empty">${escapeHtml(data.emptyText ?? "None.")}</p>` : `<ul>\n${items.join("\n")}\n</ul>`}\n${more === undefined ? "" : `<p class="omitted">${escapeHtml(more)}</p>\n`}</section>`;
}

export function evidenceListMd(data: EvidenceListData): string {
  const items = data.items.map((item) => `- \`${item.id.replace(/`/g, "")}\` ${escapeMd(item.text)}${item.detail === undefined ? "" : ` (${escapeMd(item.detail)})`}`);
  const more = tail(data);
  return [`**${escapeMd(data.title)}**`, "", ...(items.length === 0 ? [escapeMd(data.emptyText ?? "None.")] : items), ...(more === undefined ? [] : ["", `_${more}_`])].join("\n");
}
