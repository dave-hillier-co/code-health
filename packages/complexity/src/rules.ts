import type { Rule } from "@code-health/cli-kit/run-cli";

/**
 * What the labels and `check` findings mean, described by `complexity explain <rule>`. The remedy for
 * every one is judgement, and the skill holds that policy: simplify in place first, extract only a deep
 * local unit, and never split a function only to pass a guideline.
 */
export const ruleDescriptions: Record<string, Rule> = {
  cognitive: {
    summary: "Cognitive complexity: how hard a function is to read",
    explanation: [
      "Follows the SonarSource cognitive complexity specification. Each break in linear flow costs 1:",
      "if, ternary, switch, loops and catch, plus the nesting level they sit at. else if, else, a labelled",
      "break or continue, direct recursion and each sequence of like && or || operators cost a flat 1.",
      "?? and ?. are free. Nested functions add to the enclosing function's score.",
      "Labels: cognitive-warn above the guideline guidelines.cognitive.warn (default 15), cognitive-high above high (25).",
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
      "Label: nesting-warn above the guideline guidelines.nesting (default 4).",
    ].join("\n"),
  },
  parameters: {
    summary: "Parameter count",
    explanation: [
      "Declared parameters. A destructured object parameter counts once, with its properties reported as optionCount,",
      "since option bags are a common route to overexposure.",
      "Label: parameters-warn above the guideline guidelines.parameters (default 5).",
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
      "Each bump is a separate region of nested logic directly in the function: the body of each branch of an if chain, of a loop, or a whole",
      "switch or try. Structures inside a bump belong to it, and a body that fits on the line that opens it is not one. The lexical layer",
      "measures the same thing as a run of lines nested two levels or more below the function, opened by a branch keyword.",
      "A function is a bumpy road at guidelines.bumps bumps (default 3), or guidelines.deepBumps (default 2) when its deepest bump is deeper than guidelines.nesting.",
      "Each bump is a responsibility that has not been named. Simplify each in place first, with guard clauses or by flattening.",
      "Extract a bump only when it is a distinct responsibility, as a deep, well-named local function.",
    ].join("\n"),
  },
  new: {
    summary: "check: a new function above a guideline",
    explanation: [
      "`complexity check` exits with 1 when a function that did not exist at the base revision is above a guideline.",
      "A function that was renamed or moved is matched to the old one by body similarity (complexity.moveSimilarity),",
      "so it is new only when no old function resembles it.",
    ].join("\n"),
  },
  worsened: {
    summary: "check: an existing function above a guideline that got worse",
    explanation: [
      "`complexity check` exits with 1 when a function that existed at the base revision is above a guideline on a metric",
      "and that metric rose by more than complexity.delta (default 0) since. A function that stays under its",
      "guidelines never does, and neither does one that is above a guideline and did not get worse.",
    ].join("\n"),
  },
  shallow: {
    summary: "Shallow module: an exported unit whose interface is large for what it hides",
    explanation: [
      "Depth is the unit's implementation size in syntax nodes divided by its interface size. For a function the interface is",
      "its parameters (at least 1), for a class its constructor parameters plus the members a user can reach (private and # members",
      "excluded), for a module the names it exports. A unit is labelled shallow when it is exported, is not a method, and has fewer",
      "than interfaceDepth.shallow nodes (default 10) per interface element.",
      "A shallow unit is a candidate for review, not a defect: a small helper with one use is often right. Prefer deepening, by moving the",
      "decision it should hide inside it, over merging for the number. Never gate on it.",
    ].join("\n"),
  },
  "pass-through": {
    summary: "Pass-through: a function whose whole body forwards to one call",
    explanation: [
      "The body is one statement that is a call (a return, an await and a type assertion do not count as work), and every argument is a",
      "parameter of the function, a spread of one, or a literal. The function adds nothing between its caller and the callee, so the",
      "two interfaces repeat each other. A call with a computed argument, a new, or several statements is the function doing work.",
      "Remedies: let callers use the callee, or move the behaviour that justified the layer into it. A function that exists to satisfy a",
      "dependency boundary, or to give a stable name to a changing callee, may be right to keep. Judge it before removing it.",
    ].join("\n"),
  },
  fixes: {
    summary: "Fix commits per function: which functions the bug fixes of the history window changed",
    explanation: [
      "`complexity fixes` takes each logical change of the history window (history.windowMonths) that touched a source file, and maps the lines it",
      "changed in the new revision (git diff -U0 against the first parent) onto the functions and methods that contain them. A function",
      "nested in another owns its own lines. A deletion counts for the function that holds the lines either side of it. Each function is then",
      "followed forward to the current revision with the same matcher as `check` (complexity.moveSimilarity), so a renamed or moved function keeps",
      "its history, and a file renamed in git keeps the history of its functions. A function that no longer exists is listed apart, with its count.",
      "A change is a fix when a commit message matches the shared definition: history.fixPatterns, fixExcludePatterns, revertPatterns and fixMatchBody. A change that is",
      "a revert is not a fix. Each row lists the commits that matched, with the pattern, newest first, up to --evidence.",
      "fixCommits is the changes that were fixes, unitRevisions is every change that touched the function, and fixShare is the first over the second.",
      "Rows are sorted by fixCommits, then functions with at least fixes.minRevisions revisions before those labelled low evidence, then fixShare. A function in a commit that created its file counts as one revision and never as a fix.",
      "A fix that changed only lines outside every function counts against the file, not a function, and is listed per file in the output.",
      "Read the header first. fixConvention says whether the repository's messages follow a convention these patterns can use: when it says they",
      "probably do not, the counts are of the commits the patterns happened to match. The header also says how many commits were analysed and how many",
      "were skipped, by cause. By default the whole window is analysed. --max-commits N analyses the newest N commits first and skips the rest, and says so first. It costs a parse of every historical",
      "revision of the files touched, which is cached by blob, so a rerun parses nothing it has parsed before.",
      "Limits: a function moved to another file is matched only when its file was renamed, not across files. The counts are guidelines for where to look,",
      "not a ranking of defects: a function that changes often because it is the extension point has many fixes too.",
    ].join("\n"),
  },
};
