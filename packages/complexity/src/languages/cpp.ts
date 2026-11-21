import type { ComplexityLanguage } from "../complexity-language.ts";

/** The C++ readings of the shared definitions: lambdas, `goto`, and the preprocessor, which is not run. */
export const language: ComplexityLanguage = {
  id: "cpp",
  ruleNotes: {
    cognitive: [
      "A lambda is a nested function: its body is one level deeper and its structures add to the enclosing function's score.",
      "`goto` adds a flat 1, like a labelled `break` elsewhere. `break` and `continue` have no labels in C++ and cost nothing.",
      "`catch (...)` is a `catch` like any other. `&&`, `||` and their tokens `and` and `or` form sequences. A range `for` is a loop.",
      "Preprocessor branches (`#if`, `#ifdef`, `#else`) are not counted, and conditional compilation is read as written, so the statements of every branch count.",
    ],
    cyclomatic: [
      "`default:` is not a case. A lambda adds its decisions to the enclosing function and no base 1 of its own. `goto` and preprocessor branches add nothing.",
    ],
    nesting: ["A lambda does not add a level: structures inside it continue from where it sits. Preprocessor branches add no level."],
    length: ["Preprocessor directive lines are lines of code. A function's lines start at its `template <...>` line when it is a template."],
    parameters: ["`f(void)` has none. A parameter pack counts once. Default arguments do not change the count."],
  },
};
