import type { Command, CommandContext, CommandOutput, Rule } from "@code-health/cli-kit/run-cli";
import { cachedAnalysis, noCacheHelp, noCacheOption } from "../analysis.ts";
import { readSettings } from "../config.ts";
import { currentTree, normalisePaths } from "../current-tree.ts";
import { fixHeader, fixNotices, fixOptionHelp, fixOptions, fixRow, measureFixesFor } from "../fix-report.ts";
import { includeTestsHelp, includeTestsOption, splitRoles, wantsTests } from "../roles.ts";
import { ruleDescriptions } from "../rules.ts";

export const name = "fixes";

export const rules: Record<string, Rule> = { fixes: ruleDescriptions.fixes! };

/**
 * Per-function fix statistics in the manner of CodeScene's X-Ray: which functions the fix commits of the history
 * window changed, how often, and the commits that show it. Reads the history window and parses the historical
 * revisions of the files it touched.
 */
export const command: Command = {
  summary: "Per function: fix commits in the history window, revisions touching it, fix share and current cognitive complexity, with the evidence commits",
  usage: "[paths...]",
  options: { ...includeTestsOption, ...fixOptions, ...noCacheOption },
  optionHelp: { "include-tests": includeTestsHelp, ...fixOptionHelp, "no-cache": noCacheHelp },
  run(context) {
    const paths = normalisePaths(context.positionals);
    const stated = {
      paths: paths.length === 0 ? undefined : paths,
      includeTests: wantsTests(context) ? true : undefined,
      maxCommits: context.values["max-commits"],
      evidence: context.values.evidence,
    };
    const shallow = (output: CommandOutput) => ((output.extra as { shallow?: boolean } | undefined)?.shallow === true ? "the clone is shallow, and the same commit may have more history later" : undefined);
    return cachedAnalysis(context, name, stated, () => compute(context), true, shallow);
  },
};

async function compute(context: CommandContext): Promise<CommandOutput> {
  const settings = readSettings(context.config);
  const current = await currentTree(context);
  const { stats, request, paths } = await measureFixesFor(context, settings, current);
  const all = [...stats.units.values()]
    .filter((unit) => unit.fixCommits > 0)
    .map((unit) => fixRow(unit, stats.minRevisions, settings.isTest))
    .sort((a, b) => b.score - a.score || Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const { listed, tests } = splitRoles(all, wantsTests(context));
  return {
    inputs: { tree: current.kind, paths, maxCommits: request.maxCommits, evidence: request.evidence, includeTests: wantsTests(context) },
    extra: { ...fixHeader(stats, request, settings), ...(tests === null ? {} : { tests }) },
    results: listed,
    columns: ["path", "unit", "role", "fixCommits", "unitRevisions", "fixShare", "reviewFixes", "cognitive", "labels"],
    notices: [
      ...(tests === null || tests.count === 0 ? [] : [`${tests.count} test functions with fixes are not listed (--include-tests lists them with the production code, and the JSON has the first ${tests.listed} in \`tests\`)`]),
      ...fixNotices(stats, request),
    ],
  };
}
