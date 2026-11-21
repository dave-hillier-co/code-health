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
