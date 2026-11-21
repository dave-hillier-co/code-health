import type { CensusDetectors, CensusLanguage } from "./census-language.ts";
import * as registered from "./registered-languages.ts";

export const censusLanguages: readonly CensusLanguage[] = Object.values(registered).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export function censusDetectorsOf(adapterId: string): CensusDetectors {
  const language = censusLanguages.find((candidate) => candidate.id === adapterId);
  if (language === undefined) throw new Error(`structure has no census detectors for the ${adapterId} adapter: add census/languages/${adapterId}.ts and register it`);
  return language.detectors;
}
