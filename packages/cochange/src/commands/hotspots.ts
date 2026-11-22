import type { CommandContext, CommandOutput, Rule } from "@code-health/cli-kit/run-cli";
import type { LoadedHistory } from "../history-access.ts";
import { analysisCommand } from "../analysis-command.ts";
import { complexityReportInput } from "../complexity-source.ts";
import type { Derived } from "../derived-results.ts";
import { rankHotspots } from "../hotspot-ranking.ts";
import { allFilesOption, byOption, includeTestsOption, isGrouped, readBy, wantsAllFiles, wantsTests } from "../units.ts";

export const name = "hotspots";


export const rules: Record<string, Rule> = {
  hotspot: {
    summary: "Complex code that changes often and changed recently",
    explanation: [
      "A hotspot is a file (or component) whose hotspot score is in the top configured percentile of scored files",
      "(cochange.hotspotPercentile, default 90) and that was changed within the recent window (cochange.recentMonths, default 3).",
      "The score is the rank percentile of change frequency times the rank percentile of complexity, so one outlier cannot dominate it.",
      "Complexity is indentation complexity, or the complexity plugin's file report when it covers the current commit.",
      "",
      "Suggested handoff: a complexity review of the worst functions in the file. A hotspot is a prompt to look, not a verdict.",
    ].join("\n"),
  },
  "test-drift": {
    summary: "A frequently changed source file whose sibling test never changes with it",
    explanation: [
      "Raised on a file (never a component) when it has at least cochange.minSupport revisions in the analysis window,",
      "has a sibling test in the tree at the analysed commit, and no eligible logical change in the window touched both, not counting the one that created the test.",
      "A sibling test sits beside the file with a test suffix or prefix (x.test.ts, x_test.go, test_x.py, XTest.java),",
      "or under a __tests__ folder beside it. The result names it as `siblingTest`.",
      "",
      "Handoff: behaviour may be changing without the tests following. Check whether the test covers what the changes touch.",
      "A test added recently has had little chance to co-change, so read the revision count against its age.",
      "",
      "This is a prompt for investigation, not a verdict.",
    ].join("\n"),
  },
};

/**
 * The ranking is stored for each view and window. It also depends on whether a complexity report covers the
 * commit, so the stored `inputs.complexityReport` must be the one a run would read now.
 */
export const derived: Derived = {
  command: name,
  stated: (context) => ({ by: isGrouped(context) ? readBy(context) : undefined, allFiles: wantsAllFiles(context) ? true : undefined, includeTests: wantsTests(context) ? true : undefined }),
  expect: (context, head) => ({ complexityReport: complexityReportInput(context.repo.root, head) }),
};

export const command = analysisCommand(name, {
  summary: "Rank files or components by change frequency weighted by complexity",
  options: { ...byOption, ...allFilesOption, ...includeTestsOption },
  cache: derived,
  partial: (context) => isGrouped(context) || wantsAllFiles(context) || wantsTests(context),
  analyse: ({ context, history }) => rankedOutput(context, history),
});

/** The complete result of the command for the view the run states. */
export async function rankedOutput(context: CommandContext, history: LoadedHistory): Promise<CommandOutput> {
  const by = readBy(context);
  const { rows, complexity, fixConvention } = await rankHotspots(context, history, by);
  return {
    inputs: { by, allFiles: wantsAllFiles(context), includeTests: wantsTests(context), complexityReport: complexity.input },
    results: rows,
    columns: [
      "path",
      ...(by === "file" ? ["role"] : []),
      "score",
      ...(by === "component" ? ["files"] : []),
      "frequency",
      "churn",
      "complexity",
      "ageDays",
      "lastChanged",
      "landedChanges",
      "fixes",
      "fixShare",
      "reviewFixes",
      "recommendation",
      ...(by === "file" ? ["siblingTest", "findings"] : []),
    ],
    extra: { complexitySource: complexity.source, fixConvention },
    notices: fixConvention.note === null ? [] : [fixConvention.note.replace(/\.$/, "")],
  };
}
