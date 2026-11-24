import { htmlPage } from "./html-page.ts";
import type { Siblings } from "./links.ts";
import { markdownPage, type MarkdownOptions } from "./markdown-page.ts";
import { ReportError, type Format, type Notes } from "./protocol.ts";
import type { Report } from "./report-model.ts";

export interface RenderOptions extends MarkdownOptions {
  /** The report pages beside the html page, by kind and page title. Markdown links to no other page. */
  siblings?: Siblings;
}

/**
 * Renders a report. Html needs the validated notes. Markdown without them is a data-only draft whose judgement
 * blocks read "not yet written". Validate notes with `validateNotes` first.
 */
export function renderReport(report: Report, format: Format, notes: Notes | undefined, options: RenderOptions = {}): string {
  if (format === "html") {
    if (notes === undefined) throw new ReportError("html needs notes: run --slots, write the notes file, then render with --notes FILE --format html");
    return htmlPage(report, notes, options.siblings);
  }
  return markdownPage(report, notes, options);
}
