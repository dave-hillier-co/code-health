import type { ComplexityLanguage } from "../complexity-language.ts";

/** Where Python's constructs read differently from the shared definitions. */
export const language: ComplexityLanguage = {
  id: "python",
  ruleNotes: {
    cyclomatic: [
      "`elif` is an `else if`, each `case` of a `match` counts except the catch-all `case _`, and `except` counts.",
      "A comprehension adds one for each `for` and each `if` it has, and a `match` guard adds one. `and`, `or` and the conditional expression `a if c else b` count, `not` does not.",
    ],
    cognitive: [
      "`if`, `elif`, `else`, `for`, `while`, `except`, `match` and the conditional expression add as their counterparts do, and a loop's `else` adds nothing. Comprehensions add nothing and do not nest. `lambda` and nested `def` are one level deeper.",
    ],
    nesting: ["`if`, `for`, `while`, `match` and `try` nest. `with` does not, and `elif` and `else` stay at the level of their `if`."],
    parameters: ["`self` and `cls` are not counted: the first parameter of a method that is not a `staticmethod`. `*args` and `**kwargs` count once each, and a bare `*` or `/` separator not at all."],
    statements: ["Every simple and compound statement, with a nested `def` or `class`. `elif` and `else` are clauses, not statements, and a decorator is not part of the unit."],
  },
};
