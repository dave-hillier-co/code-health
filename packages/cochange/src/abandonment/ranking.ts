import { midRankPercentiles } from "@code-health/cli-kit/ranking";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import type { Rule } from "@code-health/cli-kit/run-cli";
import { rankHotspots } from "../hotspot-ranking.ts";
import type { LoadedHistory } from "../history-access.ts";
import { round4 } from "./current.ts";
import type { RankMode } from "./settings.ts";

export interface HotspotWeight {
  /** The file is a hotspot: top percentile of change frequency times complexity, and changed recently. */
  hot: boolean;
  /** The rank percentile of the file's hotspot score among scored files, 0 to 1. */
  percentile: number;
}

/**
 * The hotspot standing of every file, from the same ranking the `hotspots` command uses. A file that
 * the analysis window never saw change has no score, and a weight of 0: cold code ranks below code that changes.
 */
export async function hotspotWeights(context: CommandContext, history: LoadedHistory): Promise<Map<string, HotspotWeight>> {
  const { rows } = await rankHotspots(context, history, "file");
  const scored = rows.filter((row) => row.score !== null);
  const percentiles = midRankPercentiles(scored.map((row) => row.score!));
  const weights = new Map<string, HotspotWeight>();
  for (const row of rows) weights.set(row.path, { hot: row.recommendation === "hotspot", percentile: 0 });
  scored.forEach((row, i) => weights.set(row.path, { hot: row.recommendation === "hotspot", percentile: percentiles[i]! }));
  return weights;
}

/** The ranking score: the probability weighted by the hotspot percentile, or the probability itself under `--rank abandonment`. */
export const rankScore = (mode: RankMode, probability: number, weight: HotspotWeight | undefined): number =>
  round4(mode === "hotspot" ? probability * (weight?.percentile ?? 0) : probability);

export const FINDINGS = ["abandoned", "at-risk-hot", "at-risk-cold", "concentrated-component", "no-successor"] as const;
export type Finding = (typeof FINDINGS)[number];

export interface FileEvidence {
  /** Already abandoned at the analysed commit. */
  abandoned: boolean;
  /** Probability of being abandoned within the horizon, 0 to 1. */
  probability: number;
  hot: boolean;
  /** Asked only for files that are abandoned or at risk: no active developer has changed a file that changes with this one. */
  noSuccessor: () => boolean;
}

/** The findings of one file. `atRiskPercent` is the configured probability, in percent, at which a file is at risk. */
export function fileFindings(evidence: FileEvidence, atRiskPercent: number): Finding[] {
  const atRisk = !evidence.abandoned && evidence.probability * 100 >= atRiskPercent && evidence.probability > 0;
  const findings: Finding[] = [];
  if (evidence.abandoned) findings.push("abandoned");
  else if (atRisk) findings.push(evidence.hot ? "at-risk-hot" : "at-risk-cold");
  if ((evidence.abandoned || atRisk) && evidence.noSuccessor()) findings.push("no-successor");
  return findings;
}

export const rules: Record<string, Rule> = {
  abandoned: {
    summary: "At least the configured share of a file's lines belong to people who have left",
    explanation: [
      "A line is abandoned when its last author, by git blame -w -M -C ignoring the ignore-revs file, is no longer active:",
      "no commit within cochange.knowledge.activityWindowMonths (default 6) of the analysed commit. A file is abandoned when",
      "at least cochange.knowledge.abandonmentThreshold percent (default 90) of the lines held by people are. Lines of bots,",
      "services and agents are on neither side of the share.",
      "",
      "Suggested mitigation: adoption. Assign the top successor (`cochange successors PATH`) to the next change, and prioritise it if it is also a hotspot.",
      "Inactivity is a proxy: someone on leave looks inactive. Local overrides (.code-health/local/knowledge-overrides.json) correct it.",
    ].join("\n"),
  },
  "at-risk-hot": {
    summary: "Code that keeps changing and is likely to lose its authors",
    explanation: [
      "Raised on a file that is not abandoned, whose probability of becoming abandoned within the horizon reaches",
      "cochange.knowledge.atRiskProbability percent in the simulation, and that is a hotspot.",
      "",
      "Suggested mitigation: knowledge transfer now. Have the successors review the next changes, pair on the next change to the file,",
      "or hold a walkthrough. Simplifying a complex file also reduces what an adopter needs to know.",
      "This is a prompt for investigation, not a verdict about any person: the simulation assumes turnover is random.",
    ].join("\n"),
  },
  "at-risk-cold": {
    summary: "Rarely changed code that is likely to lose its authors",
    explanation: [
      "Raised on a file that is not abandoned, whose probability of becoming abandoned within the horizon reaches",
      "cochange.knowledge.atRiskProbability percent, and that is not a hotspot.",
      "",
      "Suggested mitigation: lightweight capture. A short design note, or characterisation tests, written while someone who knows it is still here.",
      "This is a prompt for investigation, not a verdict about any person: the simulation assumes turnover is random.",
    ].join("\n"),
  },
  "concentrated-component": {
    summary: "A component where the worst scenarios lose far more than the typical one",
    explanation: [
      "Raised on a component whose tail ratio (knowledge at risk at the lowest alpha, over the expected loss, in lines) reaches",
      "cochange.knowledge.concentratedTailRatio (default 3). A high ratio means knowledge sits with few people.",
      "",
      "Suggested mitigation: rotate reviewers within the component so that more people hold lines in it.",
    ].join("\n"),
  },
  "no-successor": {
    summary: "An abandoned or at-risk file that no active developer works near",
    explanation: [
      "Raised on an abandoned or at-risk file when no active developer has changed any file that changes with it",
      "(coupling at the configured minimum support, weighted by degree, over the analysis window).",
      "",
      "Suggested mitigation: escalate. Nobody is near this code, so adoption has no natural owner.",
    ].join("\n"),
  },
};
