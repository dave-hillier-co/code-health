import type { Rule } from "@code-health/cli-kit/run-cli";
import { analysisCommand } from "../analysis-command.ts";
import { rankHotspots } from "../hotspot-ranking.ts";
import { byOption, isGrouped, readBy } from "../units.ts";

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
};

export const command = analysisCommand(name, {
  summary: "Rank files or components by change frequency weighted by complexity",
  options: byOption,
  partial: isGrouped,
  async analyse({ context, history }) {
    const by = readBy(context);
    const { rows, complexity } = await rankHotspots(context, history, by);
    return {
      inputs: { by, complexityReport: complexity.input },
      results: rows,
      columns: [
        "path",
        "score",
        ...(by === "component" ? ["files"] : []),
        "frequency",
        "churn",
        "complexity",
        "ageDays",
        "lastChanged",
        "recommendation",
      ],
      extra: { complexitySource: complexity.source },
    };
  },
});
