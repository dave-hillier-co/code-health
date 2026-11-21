import type { Rule } from "@code-health/cli-kit/run-cli";
import { monthsBefore } from "@code-health/history/evidence";
import { analysisCommand } from "../analysis-command.ts";
import { loadComplexity } from "../complexity-source.ts";
import { midRankPercentiles, shareStrictlyAbove } from "@code-health/cli-kit/ranking";
import { SECONDS_PER_DAY, byOption, isGrouped, isoDate, loadUnits, readBy } from "../units.ts";

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
    const { settings } = history;
    const units = await loadUnits(context, history);

    const paths = [...new Set(units.flatMap((u) => [...u.members]))].sort();
    const complexity = await loadComplexity(context, history.view.headSha, paths);
    const unitComplexity = units.map((unit) => {
      const known = [...unit.members].map((path) => complexity.values.get(path) ?? null).filter((v) => v !== null);
      return known.length === 0 ? null : known.reduce((sum, v) => sum + v, 0);
    });

    const frequencyPercentile = midRankPercentiles(units.map((u) => u.revisions));
    const scoredIndexes = unitComplexity.flatMap((value, index) => (value === null ? [] : [index]));
    const complexityPercentile = new Map(
      midRankPercentiles(scoredIndexes.map((i) => unitComplexity[i]!)).map((p, k) => [scoredIndexes[k]!, p]),
    );
    const scores = units.map((_, i) => (complexityPercentile.has(i) ? frequencyPercentile[i]! * complexityPercentile.get(i)! : null));
    const scored = scores.filter((s) => s !== null);

    const anchor = history.view.headDate;
    const recentSince = monthsBefore(anchor, settings.recentMonths);
    const topShare = (100 - settings.hotspotPercentile) / 100;

    const rows = units.map((unit, i) => {
      const score = scores[i]!;
      const isHotspot =
        score !== null && shareStrictlyAbove(scored, score) < topShare && unit.lastChanged >= recentSince;
      return {
        path: unit.name,
        score,
        ...(by === "component" ? { files: unit.files } : {}),
        frequency: unit.revisions,
        churn: unit.churn,
        complexity: unitComplexity[i]!,
        ageDays: Math.floor((anchor - unit.lastChanged) / SECONDS_PER_DAY),
        lastChanged: isoDate(unit.lastChanged),
        recommendation: isHotspot ? "hotspot" : null,
      };
    });

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
