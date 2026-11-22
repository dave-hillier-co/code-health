import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { analyseIdentities } from "../identities/analysis.ts";
import { measureMapping } from "../identities/measure.ts";
import type { Turnover } from "./activity.ts";
import type { KnowledgeSettings } from "./settings.ts";

/**
 * Says what to set, and in what units, when a command needs a turnover rate and history cannot give one.
 * The rate is a percentage of developers leaving in one period, not a fraction.
 */
export function turnoverRateHint(settings: Pick<KnowledgeSettings, "periodMonths">): string {
  return `set cochange.knowledge.turnoverRate in code-health.json to the percentage of developers who leave in one ${settings.periodMonths}-month period (a number from 0 to 100, for example 15 for 15 percent)`;
}

/**
 * The share of lines held by people whose identities are settled (see `identities check`), and a notice when
 * it is under `mappedShareGuideline`. The guideline sorts and labels: the results are printed either way.
 * The notice gives the measured share, because abandonment counts one person's lines under several
 * identities as several people, and so overstates who has left.
 */
export async function mappedShareNotices(context: CommandContext, settings: KnowledgeSettings): Promise<string[]> {
  const analysis = await analyseIdentities(context, { noRefresh: true });
  const { measurement } = await measureMapping(context, analysis, { noRefresh: true });
  const share = measurement.headLines.mappedShare;
  if (measurement.headLines.people === 0 || share >= settings.mappedShareGuideline) return [];
  return [
    `Identities that are settled hold ${share}% of the lines held by people, under the guideline of ${settings.mappedShareGuideline}% (cochange.knowledge.mappedShareGuideline), so these results depend on unmapped identities; run cochange identities propose to review them`,
  ];
}

/** Notices about the turnover rate: it is a percentage, and a rate seen in few periods is a weak estimate. */
export function turnoverNotices(settings: KnowledgeSettings, turnover: Turnover, usesHistory: boolean): string[] {
  const notices: string[] = [];
  if (settings.turnoverRate !== null && settings.turnoverRate > 0 && settings.turnoverRate < 0.01) {
    notices.push(
      `cochange.knowledge.turnoverRate is ${round(settings.turnoverRate * 100)}, which is ${round(settings.turnoverRate * 100)} percent of developers leaving per ${settings.periodMonths}-month period; it is a percentage, so 30 means 30 percent`,
    );
  }
  if (usesHistory && turnover.periods.length < settings.minTurnoverPeriods) {
    notices.push(
      `The leaver probabilities come from ${turnover.periods.length} observed ${settings.periodMonths}-month period(s), under the guideline of ${settings.minTurnoverPeriods} (cochange.knowledge.minTurnoverPeriods), so they are a weak estimate; set cochange.knowledge.turnoverRate to replace them`,
    );
  }
  return notices;
}

/** The `notices` section of the output: absent when there is nothing to say. */
export const noticesSection = (notices: readonly string[]): { notices?: string[] } => (notices.length === 0 ? {} : { notices: [...notices] });

const round = (value: number): number => Math.round(value * 10_000) / 10_000;
