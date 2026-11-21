import type { ComplexityLanguage } from "../complexity-language.ts";

/** Where Kotlin's constructs differ from the shared definitions. The fixtures in fixtures/languages/kotlin/metrics pin each of them. */
export const language: ComplexityLanguage = {
  id: "kotlin",
  ruleNotes: {
    cyclomatic: [
      "A `when` counts one per entry that has a condition, and its `else` entry is not a case. An entry listing several conditions (`2, 3 ->`) is one.",
      "The elvis operator `?:` is null-coalescing and is not counted, and neither are the safe call `?.` and `!!`. Only `&&` and `||` count.",
    ],
    cognitive: [
      "`when` is one increment with nesting, with or without a subject. `if` is an expression, so Kotlin has no ternary: an `else if` and an `else` each cost 1.",
      "A lambda, an anonymous function, a local function and the methods of an anonymous object are nested functions, one level deeper.",
      "A `break@label` or `continue@label` costs 1, and the elvis operator, `?.` and `!!` are free.",
    ],
    parameters: ["A `vararg` parameter counts once. The primary constructor's parameters belong to the class, not to a unit, and a secondary constructor counts its own."],
    statements: ["Whatever stands in a block or a lambda is a statement. The branches of an `if` or `when` count too, when the `if` or `when` is itself a statement, and an expression body counts one."],
  },
};
