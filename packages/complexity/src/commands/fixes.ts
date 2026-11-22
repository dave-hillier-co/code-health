import type { Command, Rule } from "@code-health/cli-kit/run-cli";
import { readSettings } from "../config.ts";
import { currentTree } from "../current-tree.ts";
import { fixHeader, fixNotices, fixOptionHelp, fixOptions, fixRow, measureFixesFor } from "../fix-report.ts";
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
  options: { ...fixOptions },
  optionHelp: { ...fixOptionHelp },
  async run(context) {
    const settings = readSettings(context.config);
    const current = await currentTree(context);
    const { stats, request, paths } = await measureFixesFor(context, settings, current);
    const rows = [...stats.units.values()].filter((unit) => unit.fixCommits > 0).map((unit) => fixRow(unit, stats.minRevisions));
    return {
      inputs: { tree: current.kind, paths, maxCommits: request.maxCommits, evidence: request.evidence },
      extra: fixHeader(stats, request),
      results: rows,
      columns: ["path", "unit", "fixCommits", "unitRevisions", "fixShare", "cognitive", "labels"],
      notices: fixNotices(stats, request),
    };
  },
};
