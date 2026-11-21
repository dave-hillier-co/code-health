import type { ComplexityLanguage } from "../language.ts";

/** Where Rust's constructs differ from the shared definitions. The construct mapping is the adapter's `MetricRules` (parse/languages/rust/metric-rules.ts). */
export const language: ComplexityLanguage = {
  id: "rust",
  ruleNotes: {
    cognitive: [
      "`match` is a switch and costs 1 plus its nesting level, whatever its number of arms. `if let` and `while let` are an `if` and a `while`.",
      "The `?` operator is not counted: it leaves a function early without a branch in the source.",
      "`&&` and `||` count as in other languages, also inside a let chain (`if a && let Some(b) = c`).",
      "A closure is a nested function, one level deeper, and adds to its function's score.",
      "A labelled `break` or `continue` costs a flat 1, and so does a direct recursive call, as `name()`, `self.name()` or `Self::name()`.",
    ],
    cyclomatic: [
      "Every `match` arm is a case, the wildcard arm included, because a `match` is exhaustive and its last arm is one of the choices; a `match` is one decision in the modified mode.",
      "`if let` and `while let` are one decision each. `?` and `|` between patterns are not decisions. `loop` is a loop.",
    ],
    nesting: ["`if`, `if let`, `for`, `while`, `loop` and `match` nest. Closures and nested functions continue from where they sit."],
    parameters: ["`self` is not a parameter. A destructured struct pattern counts once, and its fields are reported as optionCount."],
  },
};
