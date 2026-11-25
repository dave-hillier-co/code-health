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

/** The share of lines held by people whose identities are settled, when it is under `mappedShareGuideline`. */
export interface MappedShare {
  /** Percentage, 0 to 100, or null when it reaches the guideline or no person holds a line. */
  under: number | null;
  notices: string[];
}

/**
 * The share of lines held by people whose identities are settled (see `identities check`), and a notice when
 * it is under `mappedShareGuideline`. The guideline sorts and labels: the results are printed either way.
 * The notice gives the measured share, because abandonment counts one person's lines under several
 * identities as several people, and so overstates who has left.
 */
export async function readMappedShare(context: CommandContext, settings: KnowledgeSettings): Promise<MappedShare> {
  const analysis = await analyseIdentities(context, { noRefresh: true });
  const { measurement } = await measureMapping(context, analysis, { noRefresh: true });
  const share = measurement.headLines.mappedShare;
  if (measurement.headLines.people === 0 || share >= settings.mappedShareGuideline) return { under: null, notices: [] };
  return {
    under: share,
    notices: [
      `Identities that are settled hold ${share}% of the lines held by people, under the guideline of ${settings.mappedShareGuideline}% (cochange.knowledge.mappedShareGuideline), so these results depend on unmapped identities; run cochange identities propose to review them${strongClause(measurement.headLines)}`,
    ],
  };
}

export async function mappedShareNotices(context: CommandContext, settings: KnowledgeSettings): Promise<string[]> {
  return (await readMappedShare(context, settings)).notices;
}

/**
 * A notice that the simulated loss is an upper bound, when the mean leaver probability reaches
 * `leaverProbabilityGuideline` or the mapped share is under its guideline. A high leaver probability means most of
 * the team leaves in a typical trial, so the expected loss is close to the worst case and the tail ratio close to 1;
 * the pooled rate is raised by occasional contributors, who leave more often than the people holding most lines.
 * Unmapped identities split one person into several, and an old address that stopped committing counts as someone who left.
 */
export function upperBoundNotices(settings: KnowledgeSettings, leaverProbability: number, mappedShareUnder: number | null): string[] {
  const reasons: string[] = [];
  const percent = Math.round(leaverProbability * 1000) / 10;
  if (percent >= settings.leaverProbabilityGuideline) {
    reasons.push(
      `the mean probability that an active developer leaves within the horizon is ${percent}%, at or above the guideline of ${settings.leaverProbabilityGuideline}% (cochange.knowledge.leaverProbabilityGuideline), so most of the team leaves in a typical trial, the expected loss is close to the worst case and the tail ratio is close to 1; one pooled rate also counts occasional contributors, who leave more often than the people holding most lines`,
    );
  }
  if (mappedShareUnder !== null) {
    reasons.push(
      `settled identities hold ${mappedShareUnder}% of the lines held by people, under the guideline of ${settings.mappedShareGuideline}% (cochange.knowledge.mappedShareGuideline), and an unmapped address a person no longer commits under counts as someone who has left`,
    );
  }
  return reasons.length === 0 ? [] : [`The loss figures are an upper bound: ${reasons.join("; and ")}`];
}

/** How much of the unmapped lines needs no decision, because strong proposals already settle them. */
function strongClause(lines: { people: number; unmappedStrong: number }): string {
  if (lines.unmappedStrong === 0) return "";
  const percent = Math.round((lines.unmappedStrong / lines.people) * 1000) / 10;
  return `; ${percent}% of the lines held by people are in strong proposals, which the identities skill applies without asking`;
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

/** A notice when a command groups by component and the config names none, so every file is in the unassigned group. */
export function componentNotices(components: readonly unknown[]): string[] {
  if (components.length > 0) return [];
  return ["No components are configured (components in code-health.json), so every file is in the (unassigned) group and components cannot be compared; add components to group files into parts of the repository"];
}

/** Why the adoption rates are null, when they are: nothing was abandoned at the date, or nothing abandoned was adopted. */
export function adoptionNotices(at: string, summary: { abandoned: number; adopted: number }): string[] {
  if (summary.abandoned === 0) return [`adoptionRate and recommendationHitRate are null: no file was abandoned at ${at}, so there is nothing to measure adoption of`];
  if (summary.adopted === 0) {
    return [`recommendationHitRate is null: none of the ${summary.abandoned} files abandoned at ${at} was adopted within the horizon, so there is no adoption to compare the recommended successors with`];
  }
  return [];
}

/** The `notices` section of the output: absent when there is nothing to say. */
export const noticesSection = (notices: readonly string[]): { notices?: string[] } => (notices.length === 0 ? {} : { notices: [...notices] });

const round = (value: number): number => Math.round(value * 10_000) / 10_000;
