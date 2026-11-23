import { escapeMd, inlineHtml } from "../text.ts";

export interface NoticeData {
  /** The word that opens the notice. A notice is never told apart by colour alone. */
  level: "notice" | "limit" | "warning";
  text: string;
}

const WORD = { notice: "Notice", limit: "Limit", warning: "Warning" } as const;

export function noticeHtml(data: NoticeData): string {
  return `<aside class="notice ${data.level}" role="note"><strong>${WORD[data.level]}:</strong> ${inlineHtml(data.text)}</aside>`;
}

export function noticeMd(data: NoticeData): string {
  return `> **${WORD[data.level]}:** ${escapeMd(data.text)}`;
}
