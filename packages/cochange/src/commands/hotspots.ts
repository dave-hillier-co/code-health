import type { Rule } from "@code-health/cli-kit/run-cli";
import { listTree } from "@code-health/history/tree";
import { monthsBefore } from "@code-health/history/evidence";
import { analysisCommand } from "../analysis-command.ts";
import { loadComplexity } from "../complexity-source.ts";
import { siblingTestOf } from "../sibling-test.ts";
import { midRankPercentiles, shareStrictlyAbove } from "../ranking.ts";
import type { Unit } from "../file-statistics.ts";
import type { LoadedHistory } from "../history-access.ts";
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

    const drifting = by === "file" ? await testDrift(context.repo.root, history, units.map((u) => u.name)) : new Map();

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
        ...(by === "file" ? fileFindings(unit, isHotspot, drifting.get(unit.name) ?? null, settings.minSupport) : {}),
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
        ...(by === "file" ? ["siblingTest", "findings"] : []),
      ],
      extra: { complexitySource: complexity.source },
    };
  },
});

interface SiblingEvidence {
  test: string;
  /** Eligible logical changes touching both the file and its test. */
  together: number;
}

/** The sibling test of each file that has one, and how often the two changed together. */
async function testDrift(root: string, history: LoadedHistory, paths: readonly string[]): Promise<Map<string, SiblingEvidence>> {
  const tree = new Set(await listTree(root, history.view.headSha));
  const siblings = new Map(paths.flatMap((path) => {
    const test = siblingTestOf(path, tree);
    return test === null ? [] : [[path, test] as const];
  }));
  const together = new Map<string, number>();
  for (const change of history.filtered.changes) {
    if (change.oversized) continue;
    const touched = new Map(change.files.map((file) => [file.fileId, file.status] as const));
    for (const [path, test] of siblings) {
      // The change that created the test is not evidence that later changes update it.
      if (touched.has(path) && touched.has(test) && touched.get(test) !== "A") together.set(path, (together.get(path) ?? 0) + 1);
    }
  }
  return new Map([...siblings].map(([path, test]) => [path, { test, together: together.get(path) ?? 0 }]));
}

function fileFindings(unit: Unit, isHotspot: boolean, sibling: SiblingEvidence | null, minSupport: number) {
  const drift = sibling !== null && sibling.together === 0 && unit.revisions >= minSupport;
  return { siblingTest: sibling?.test ?? null, findings: [...(isHotspot ? ["hotspot"] : []), ...(drift ? ["test-drift"] : [])] };
}
