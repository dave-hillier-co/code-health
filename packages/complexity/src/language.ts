import { adapterById } from "@code-health/parse/languages";
import type { ComplexityLanguage } from "./complexity-language.ts";
import * as registered from "./registered-languages.ts";

export const complexityLanguages: readonly ComplexityLanguage[] = Object.values(registered).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** The explanation of a rule with each language's own notes appended, one paragraph per language. */
export function explainRule(rule: string, explanation: string): string {
  const notes = complexityLanguages.flatMap((language) => {
    const lines = language.ruleNotes[rule];
    const name = adapterById(language.id)?.name ?? language.id;
    return lines === undefined || lines.length === 0 ? [] : [`${name}: ${lines.join(" ")}`];
  });
  return notes.length === 0 ? explanation : `${explanation}\n${notes.join("\n")}`;
}
