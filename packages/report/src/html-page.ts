import { renderBlock } from "./block.ts";
import type { Notes } from "./protocol.ts";
import type { Report, Section } from "./report-model.ts";
import { escapeHtml, formatNumber, inlineHtml } from "./text.ts";
import { themeCss } from "./theme.ts";

function headerFacts(report: Report): string {
  const { header } = report;
  const excluded =
    header.excluded.length === 0
      ? "nothing"
      : `<ul>${header.excluded.map((e) => `<li>${escapeHtml(e.what)}: ${formatNumber(e.count)}</li>`).join("")}</ul>`;
  const rows: [string, string][] = [
    ["Repository", escapeHtml(header.repo)],
    ["Analysed commit", `<code>${escapeHtml(header.commit)}</code>`],
    ["Date", escapeHtml(header.date)],
    ["Config hash", `<code>${escapeHtml(header.configHash)}</code>`],
    ["Evidence grade", escapeHtml(header.evidenceGrade)],
    ["History window", escapeHtml(header.historyWindow)],
    ["Excluded", excluded],
  ];
  return `<dl class="header">\n${rows.map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join("\n")}\n</dl>`;
}

function section(s: Section, report: Report, notes: Notes): string {
  const body = s.blocks.map((block) => renderBlock(block, "html", { slots: report.slots, notes })).join("\n");
  return `<section id="${escapeHtml(s.id)}" aria-labelledby="${escapeHtml(s.id)}-heading">\n<h2 id="${escapeHtml(s.id)}-heading">${escapeHtml(s.heading)}</h2>\n${body}\n</section>`;
}

function limitsSection(report: Report, notes: Notes): string {
  const slot = report.slots.find((s) => s.id === "limits");
  const fixed = report.limits.map((text) => `<li>${inlineHtml(text)}</li>`).join("\n");
  const judged = slot === undefined ? "" : renderBlock({ type: "judgement", slot: slot.id }, "html", { slots: report.slots, notes });
  return `<section id="limits" aria-labelledby="limits-heading">\n<h2 id="limits-heading">Limits</h2>\n${fixed === "" ? "" : `<ul>\n${fixed}\n</ul>\n`}${judged}\n</section>`;
}

/** The report as one self-contained html page: inline CSS and svg, no script, no external request. */
export function htmlPage(report: Report, notes: Notes): string {
  const ids = [...report.sections.map((s) => [s.id, s.heading] as const), ["limits", "Limits"] as const];
  const nav = `<nav aria-label="Sections">\n<ul>\n${ids.map(([id, heading]) => `<li><a href="#${escapeHtml(id)}">${escapeHtml(heading)}</a></li>`).join("\n")}\n</ul>\n</nav>`;
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${escapeHtml(report.title)}</title>`,
    `<style>${themeCss}</style>`,
    "</head>",
    "<body>",
    '<a class="skip" href="#main">Skip to the report</a>',
    `<header>\n<h1>${escapeHtml(report.title)}</h1>\n${headerFacts(report)}\n</header>`,
    nav,
    '<main id="main">',
    ...report.sections.map((s) => section(s, report, notes)),
    limitsSection(report, notes),
    "</main>",
    `<footer>\n<p>Report <code>${escapeHtml(report.kind)}</code> for commit <code>${escapeHtml(report.header.commit.slice(0, 12))}</code>. Every number comes from the command's data. The judgements were written by an agent from that data and checked against the report's slots.</p>\n</footer>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
