import { escapeMd, inlineHtml } from "../text.ts";

export interface NoticeData {
  /** The word that opens the notice. A notice is never told apart by colour alone. */
  level: "notice" | "limit" | "warning";
  text: string;
}

/**
 * Notices from command output are written without a final full stop, because the command line adds one after each
 * (`Notice: ...`). A page prints the sentence, so it ends with one. Text that already ends in a full stop, an
 * exclamation or question mark, or a closing code span after one is kept.
 */
export function endWithFullStop(text: string): string {
  const trimmed = text.trimEnd();
  return /[.!?]["')\]`]*$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

const WORD = { notice: "Notice", limit: "Limit", warning: "Warning" } as const;

export function noticeHtml(data: NoticeData): string {
  return `<aside class="notice ${data.level}" role="note"><strong>${WORD[data.level]}:</strong> ${inlineHtml(endWithFullStop(data.text))}</aside>`;
}

export function noticeMd(data: NoticeData): string {
  return `> **${WORD[data.level]}:** ${escapeMd(endWithFullStop(data.text))}`;
}
