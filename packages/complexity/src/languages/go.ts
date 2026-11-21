import type { ComplexityLanguage } from "../language.ts";

/** Go has no exceptions, ternary or compound logical assignment, and spells its multi-way branches `switch`, a type switch and `select`. */
export const language: ComplexityLanguage = {
  id: "go",
  ruleNotes: {
    cognitive: [
      "`switch`, a type switch and `select` each cost 1 plus their nesting level, whatever their cases.",
      "`if err != nil` is an ordinary `if`, so error handling costs what any branch costs.",
      "`defer` and `go` statements are not counted, but a function literal is a nested function: what it holds is one level deeper.",
      "`goto`, and `break` or `continue` with a label, cost a flat 1.",
    ],
    cyclomatic: ["Each `case` of a `switch`, type switch or `select` counts, and `default` does not. `for` covers every loop, ranges included."],
    nesting: ["`if`, `for`, `switch`, type switch and `select` add a level."],
    parameters: ["Each name of `a, b int` counts, an unnamed parameter counts once, and the receiver is not a parameter."],
  },
};
