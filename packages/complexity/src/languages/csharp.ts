import type { ComplexityLanguage } from "../language.ts";

/** What differs in C# from the shared definitions: switch expressions, pattern combinators and null-coalescing. */
export const language: ComplexityLanguage = {
  id: "csharp",
  ruleNotes: {
    cognitive: [
      "A switch expression costs like a switch statement: 1 plus its nesting level, and its arms are one level deeper.",
      "A run of like pattern combinators (`or`, `and`) costs 1, as a run of `&&` or `||` does, and `not` costs nothing.",
      "`??`, `??=` and `?.` are free. Lambdas, anonymous methods and local functions are one level deeper and add to the enclosing function.",
    ],
    cyclomatic: [
      "Each `case` label counts, so `case 1: case 2:` is two. Each arm of a switch expression counts except the catch-all `_ =>` with no `when` guard,",
      "which is `default:`. With cyclomaticSwitch set to modified, a switch statement or expression counts 1 whatever its arms.",
      "Each pattern combinator (`or`, `and`), `??` and `??=` is a decision. `?.`, `is`, `not` and `finally` are not.",
    ],
    nesting: ["Switch expressions nest like switch statements. Lambdas and local functions do not add a level of their own."],
    parameters: [
      "Every declared parameter counts, a `params` array and the receiver of an extension method included. The accessors of an indexer take the indexer's parameters.",
    ],
    length: ["Properties with accessors are measured per accessor (`Cached.get`), and an expression-bodied property or method as one function. Signatures with no body are not functions."],
  },
};
