import { usageError } from "@code-health/cli-kit/errors";
import type { Rule } from "@code-health/cli-kit/run-cli";
import { analysisCommand } from "../analysis-command.ts";
import { readFixClassifier } from "../risk/settings.ts";
import { readFixes, statisticsOf } from "../fix-statistics.ts";
import { allFilesOption, byOption, isGrouped, loadUnits, readBy, wantsAllFiles } from "../units.ts";

export const name = "fixes";

const DEFAULT_EVIDENCE = 5;

export const rules: Record<string, Rule> = {
  "fix-count": {
    summary: "How many of the changes to a file or component were fixes, by commit message",
    explanation: [
      "Fixes are counted per change that landed on the main line (the first-parent line), classified by the change's own text. A squash or direct commit is classified by its message. A merge commit is classified by the pull request title: the line after the blank one in 'Merge pull request #N from owner/branch', the title in 'Merge pull request #N: title', or the title under GitLab's \"Merge branch 'x' into 'main'\".",
      "A landed change is a fix when that text matches history.fixPatterns (default: fix, fixes, fixed or fixing at the start of the subject or after 'to', the whole words bug, bugfix, hotfix and defect, a fix: prefix, a merge of a fix branch),",
      "and a revert when it matches history.revertPatterns or says 'This reverts commit'. A revert is counted in its own column and is not a fix.",
      "A change that a fix pattern matched is left out, and counted in fixesExcluded with the pattern that excluded it, when history.fixExcludePatterns matches the subject (default: a non-fix Conventional Commits type such as chore, ci, test or docs, or a fix target of typos, spelling, lint or formatting).",
      "Bodies are matched only with history.fixMatchBody. The count is per file or component, once per landed change, over the same window and noise filters as hotspots.",
      "The commits that only a merge's later parents reach belong to the landed change, and a fix made there was caught in review, so it is not a regression. Their fix-like messages are counted apart as reviewFixes, with reviewEvidence, and never in fixes.",
      "landedChanges is the number of landed changes that touched the file or component, and fixShare is fixes over landedChanges. revisions counts every commit, as hotspots does, so it is not the denominator of fixShare.",
      "",
      "This is a count of commit messages, not of defects. A message such as 'fix the bug report template' matches, and a fix that does not say so does not.",
      "The output carries the convention check as fixConvention: it says whether the landed changes' titles use a recognisable fix form (Conventional Commits types, a leading Fix or Fixes, or issue references) and counts each form. The share of fixes is reported beside it and does not decide the verdict. When no form is seen the commit messages probably do not follow a convention this can use, and the table prints a Notice.",
      "Read the evidence commits before relying on a count, and read it with hotspots (change frequency) and complexity (what makes the code hard to change).",
    ].join("\n"),
  },
};

function excludedNotice(count: number, byPattern: { pattern: string; count: number }[]): string {
  return `${count} changes matched a fix pattern and were left out because the commit has a non-fix Conventional Commits type, or is about typos, spelling, lint or formatting (history.fixExcludePatterns): ${byPattern.map((entry) => `${entry.count} by ${entry.pattern}`).join("; ")}`;
}

function evidenceOption(value: unknown): number {
  if (value === undefined) return DEFAULT_EVIDENCE;
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw usageError(`--evidence must be a whole number, got "${String(value)}"`);
  return Number(value);
}

export const command = analysisCommand(name, {
  summary: "Rank files or components by how many of their changes were fixes, with the matching commits",
  options: { ...byOption, ...allFilesOption, evidence: { type: "string" } },
  partial: (context) => isGrouped(context) || wantsAllFiles(context) || context.values.evidence !== undefined,
  async analyse({ context, history }) {
    const by = readBy(context);
    const evidenceLimit = evidenceOption(context.values.evidence);
    const units = await loadUnits(context, history, by);
    const reading = await readFixes(history, units, readFixClassifier(context.config), context.repo.root);
    const rows = units.map((unit) => {
      const stats = statisticsOf(reading, unit);
      return {
        path: unit.name,
        score: stats.fixes,
        ...(by === "component" ? { files: unit.files } : {}),
        fixes: stats.fixes,
        revisions: unit.revisions,
        landedChanges: stats.landedChanges,
        fixShare: stats.fixShare,
        recentFixes: stats.recentFixes,
        lastFix: stats.lastFix,
        reverts: stats.reverts,
        evidence: { commits: stats.commits.slice(0, evidenceLimit), omitted: Math.max(0, stats.commits.length - evidenceLimit) },
        reviewFixes: stats.reviewFixes,
        reviewEvidence: { commits: stats.reviewCommits.slice(0, evidenceLimit), omitted: Math.max(0, stats.reviewCommits.length - evidenceLimit) },
      };
    });
    const { convention } = reading;
    return {
      inputs: { by, allFiles: wantsAllFiles(context), evidenceLimit },
      results: rows,
      columns: ["path", ...(by === "component" ? ["files"] : []), "fixes", "revisions", "landedChanges", "fixShare", "recentFixes", "lastFix", "reverts", "evidence", "reviewFixes", "reviewEvidence"],
      extra: { fixConvention: convention, fixesExcluded: reading.excluded, fixesDuringReview: reading.reviewFixes },
      notices: [
        ...(convention.note === null ? [] : [convention.note.replace(/\.$/, "")]),
        ...(reading.excluded.fixes === 0 ? [] : [excludedNotice(reading.excluded.fixes, reading.excluded.byPattern)]),
      ],
    };
  },
});
