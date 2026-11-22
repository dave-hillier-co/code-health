import { usageError } from "@code-health/cli-kit/errors";
import type { Rule } from "@code-health/cli-kit/run-cli";
import { analysisCommand } from "../analysis-command.ts";
import { readFixClassifier } from "../risk/settings.ts";
import { readFixes, statisticsOf } from "../fix-statistics.ts";
import { byOption, isGrouped, loadUnits, readBy } from "../units.ts";

export const name = "fixes";

const DEFAULT_EVIDENCE = 5;

export const rules: Record<string, Rule> = {
  "fix-count": {
    summary: "How many of the changes to a file or component were fixes, by commit message",
    explanation: [
      "A logical change is a fix when one of its commits matches history.fixPatterns (default: the whole words fix, bug, issue and similar in the subject, a fix: prefix, a merge of a fix branch),",
      "and a revert when one matches history.revertPatterns or says 'This reverts commit'. A revert is counted in its own column and is not a fix.",
      "Bodies are matched only with history.fixMatchBody. The count is per file or component, once per logical change, over the same window and noise filters as hotspots.",
      "",
      "This is a count of commit messages, not of defects. A message such as 'address review issue' matches, and a fix that does not say so does not.",
      "The output carries the convention check as fixConvention: when fixes are under 2 percent or over 60 percent of logical changes, or there are fewer than 30, the commit messages probably do not follow a convention this can use, and the table prints a Notice.",
      "Read the evidence commits before relying on a count, and read it with hotspots (change frequency) and complexity (what makes the code hard to change).",
    ].join("\n"),
  },
};

function evidenceOption(value: unknown): number {
  if (value === undefined) return DEFAULT_EVIDENCE;
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw usageError(`--evidence must be a whole number, got "${String(value)}"`);
  return Number(value);
}

export const command = analysisCommand(name, {
  summary: "Rank files or components by how many of their changes were fixes, with the matching commits",
  options: { ...byOption, evidence: { type: "string" } },
  partial: (context) => isGrouped(context) || context.values.evidence !== undefined,
  async analyse({ context, history }) {
    const by = readBy(context);
    const evidenceLimit = evidenceOption(context.values.evidence);
    const units = await loadUnits(context, history, by);
    const reading = readFixes(history, units, readFixClassifier(context.config));
    const rows = units.map((unit) => {
      const stats = statisticsOf(reading, unit);
      return {
        path: unit.name,
        score: stats.fixes,
        ...(by === "component" ? { files: unit.files } : {}),
        fixes: stats.fixes,
        revisions: unit.revisions,
        fixShare: stats.fixShare,
        recentFixes: stats.recentFixes,
        lastFix: stats.lastFix,
        reverts: stats.reverts,
        evidence: { commits: stats.commits.slice(0, evidenceLimit), omitted: Math.max(0, stats.commits.length - evidenceLimit) },
      };
    });
    const { convention } = reading;
    return {
      inputs: { by, evidenceLimit },
      results: rows,
      columns: ["path", ...(by === "component" ? ["files"] : []), "fixes", "revisions", "fixShare", "recentFixes", "lastFix", "reverts", "evidence"],
      extra: { fixConvention: convention },
      notices: convention.note === null ? [] : [convention.note.replace(/\.$/, "")],
    };
  },
});
