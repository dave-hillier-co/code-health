import { htmlPage } from "./html-page.ts";
import { markdownPage, type MarkdownOptions } from "./markdown-page.ts";
import { ReportError, type Format, type Notes } from "./protocol.ts";
import type { Report } from "./report-model.ts";

/**
 * Renders a report. Html needs the validated notes. Markdown without them is a data-only draft whose judgement
 * blocks read "not yet written". Validate notes with `validateNotes` first.
 */
export function renderReport(report: Report, format: Format, notes: Notes | undefined, options: MarkdownOptions = {}): string {
  if (format === "html") {
    if (notes === undefined) throw new ReportError("html needs notes: run --slots, write the notes file, then render with --notes FILE --format html");
    return htmlPage(report, notes);
  }
  return markdownPage(report, notes, options);
}
