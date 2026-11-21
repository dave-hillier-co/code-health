import type { ComplexityLanguage } from "../language.ts";

/** Where Java's constructs differ from the shared definitions. The fixtures in fixtures/languages/java/metrics pin each of them. */
export const language: ComplexityLanguage = {
  id: "java",
  ruleNotes: {
    cyclomatic: [
      "A switch counts one per case label, and a label listing several values (`case 1, 7 ->`) is one; `default` is not a case.",
      "Java has no null-coalescing operator, so `&&`, `||` and the ternary are the only operators that count.",
    ],
    cognitive: [
      "A switch statement and a switch expression are the same construct: one increment with nesting, whatever the form of its labels.",
      "A lambda and a method of an anonymous class are nested functions, one level deeper, and add to the method that holds them.",
      "A `break` or `continue` with a label costs 1. `try` with resources nests like `try`, and `catch` is a decision.",
    ],
    parameters: ["A varargs parameter counts once, and so does each parameter of a constructor. A compact record constructor declares none."],
    statements: ["An expression statement in a switch rule counts, a lambda with an expression body counts one, and an explicit `this(...)` or `super(...)` call is a statement."],
  },
};
