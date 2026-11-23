import { emptySection } from "./empty-block.ts";
import { renderBlock } from "./block.ts";
import type { Notes } from "./protocol.ts";
import type { Report } from "./report-model.ts";
import { codeSpan, escapeMd, formatNumber } from "./text.ts";

export interface MarkdownOptions {
  /** The form for a pull request comment: the header on two lines and no blank line more than the blocks need. */
  compact?: boolean;
}

function header(report: Report, compact: boolean): string[] {
  const h = report.header;
  if (compact) {
    const total = h.excluded.reduce((sum, e) => sum + e.count, 0);
    const excluded = h.excluded.length === 0 ? "nothing" : `${formatNumber(total)} in total across ${formatNumber(h.excluded.length)} ${h.excluded.length === 1 ? "kind" : "kinds"}; the full report lists each`;
    return [
      `- Repository ${codeSpan(h.repo)} at \`${h.commit.slice(0, 12)}\` on ${h.date}; config hash \`${h.configHash}\``,
      `- Evidence grade: ${escapeMd(h.evidenceGrade)}. History window: ${escapeMd(h.historyWindow)}`,
      `- Excluded: ${excluded}`,
    ];
  }
  return [
    `- Repository: ${escapeMd(h.repo)}`,
    `- Analysed commit: \`${h.commit}\``,
    `- Date: ${h.date}`,
    `- Config hash: \`${h.configHash}\``,
    `- Evidence grade: ${escapeMd(h.evidenceGrade)}`,
    `- History window: ${escapeMd(h.historyWindow)}`,
    ...(h.excluded.length === 0 ? ["- Excluded: nothing"] : ["- Excluded:", ...h.excluded.map((e) => `  - ${escapeMd(e.what)}: ${formatNumber(e.count)}`)]),
  ];
}

/** The report as markdown: headings, lists and tables only. Without notes the judgement blocks read "not yet written", for a data-only draft. */
export function markdownPage(report: Report, notes: Notes | undefined, options: MarkdownOptions = {}): string {
  const context = { slots: report.slots, notes };
  const limits = report.limits.map((text) => `- ${escapeMd(text)}`);
  const slot = report.slots.find((s) => s.id === "limits");
  const judged = slot === undefined ? [] : [renderBlock({ type: "judgement", slot: slot.id }, "md", context)];
  return (
    [
      `# ${escapeMd(report.title)}`,
      header(report, options.compact === true).join("\n"),
      ...report.sections.map((s) => {
        const empty = emptySection(s);
        return empty === undefined ? [`## ${escapeMd(s.heading)}`, ...s.blocks.map((b) => renderBlock(b, "md", context))].join("\n\n") : `**${escapeMd(s.heading)}:** ${escapeMd(empty)}`;
      }),
      ["## Limits", ...(limits.length === 0 ? [] : [limits.join("\n")]), ...judged].join("\n\n"),
    ].join("\n\n") + "\n"
  );
}
