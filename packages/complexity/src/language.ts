import { adapterById } from "@code-health/parse/languages";
import * as registered from "./registered-languages.ts";

/**
 * What `complexity explain <rule>` adds for a language, beyond the shared definition of each rule. The
 * shared text is the SonarSource cognitive complexity specification applied to the constructs every
 * language has; a language says where its own constructs differ: Kotlin `when`, Rust `?` not counted, C#
 * switch expressions and pattern combinators, Go `if err != nil` counted as an ordinary `if`. A language
 * is one file in `languages/<id>.ts` and one line in `registered-languages.ts`. The `id` is the adapter's.
 *
 * The construct mapping that implements these lives in the adapter's `MetricRules` in the parse package,
 * and the conformance fixtures under `fixtures/languages/<id>/metrics` pin it down.
 */
export interface ComplexityLanguage {
  id: string;
  /** Lines per rule name (`cognitive`, `cyclomatic`, `nesting`, `parameters`, `length`) that describe this language's differences. */
  ruleNotes: Readonly<Record<string, readonly string[]>>;
}

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
