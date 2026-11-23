import { escapeMd, inlineHtml } from "../text.ts";

export interface ParagraphData {
  text: string;
}

export const paragraphHtml = (data: ParagraphData): string => `<p>${inlineHtml(data.text)}</p>`;

export const paragraphMd = (data: ParagraphData): string => escapeMd(data.text);
