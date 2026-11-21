import type { Rule } from "@code-health/cli-kit/run-cli";

/**
 * What the labels and `check` findings mean, described by `complexity explain <rule>`. The remedy for
 * every one is judgement, and the skill holds that policy: simplify in place first, extract only a deep
 * local unit, and never split a function to pass a threshold.
 */
export const ruleDescriptions: Record<string, Rule> = {
  cognitive: {
    summary: "Cognitive complexity: how hard a function is to read",
    explanation: [
      "Follows the SonarSource cognitive complexity specification. Each break in linear flow costs 1:",
      "if, ternary, switch, loops and catch, plus the nesting level they sit at. else if, else, a labelled",
      "break or continue, direct recursion and each sequence of like && or || operators cost a flat 1.",
      "?? and ?. are free. Nested functions add to the enclosing function's score.",
      "Labels: cognitive-warn above thresholds.cognitive.warn (default 15), cognitive-high above high (25).",
      "Run `complexity explain path#Unit` to see which construct cost what.",
    ].join("\n"),
  },
  cyclomatic: {
    summary: "Cyclomatic complexity: independent paths through a function",
    explanation: [
      "1 plus decision points: if, else if, loops, each case (or one per switch when cyclomaticSwitch is modified),",
      "catch, the ternary, and && || ?? (also as &&= ||= ??=). Optional chaining is not counted.",
      "It bounds the number of test paths, so it measures testability more than readability.",
      "Labels: cyclomatic-warn above 10, cyclomatic-high above 20 by default.",
    ].join("\n"),
  },
  nesting: {
    summary: "Nesting depth of control structures",
    explanation: [
      "The deepest nesting of if, loop, switch and try statements in the function. An else if sits at the level of its if.",
      "Label: nesting-warn above thresholds.nesting (default 4).",
    ].join("\n"),
  },
  parameters: {
    summary: "Parameter count",
    explanation: [
      "Declared parameters. A destructured object parameter counts once, with its properties reported as optionCount,",
      "since option bags are a common route to overexposure.",
      "Label: parameters-warn above thresholds.parameters (default 5).",
    ].join("\n"),
  },
  length: {
    summary: "Lines of code in a function",
    explanation: [
      "Lines holding code, with blank lines and comments left out. It is reported and ranked but never labelled or gated:",
      "a long, linear function is often clearer than five shallow fragments.",
    ].join("\n"),
  },
  "bumpy-road": {
    summary: "Several separate chunks of nested logic in one function",
    explanation: [
      "A lexical measure: each bump is a run of lines nested two levels or more below the function, opened by a branch keyword.",
      "Each bump is a responsibility that has not been named. Simplify each in place first, with guard clauses or by flattening.",
      "Extract a bump only when it is a distinct responsibility, as a deep, well-named local function.",
    ].join("\n"),
  },
  new: {
    summary: "check: a new function over a threshold",
    explanation: [
      "`complexity check` fails when a function that did not exist at the base revision is over a threshold.",
      "A function that was renamed or moved is matched to the old one by body similarity (complexity.moveSimilarity),",
      "so it is new only when no old function resembles it.",
    ].join("\n"),
  },
  worsened: {
    summary: "check: an existing function over a threshold that got worse",
    explanation: [
      "`complexity check` fails when a function that existed at the base revision is over a threshold on a metric",
      "and that metric rose by more than complexity.delta (default 0) since. A function that stays under its",
      "thresholds never fails, and neither does one that is over a threshold and did not get worse.",
    ].join("\n"),
  },
};
