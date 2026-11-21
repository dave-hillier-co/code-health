import type { Rule } from "@code-health/cli-kit/run-cli";

const lines = (...text: string[]): string => text.join("\n");

/** Every rule `recommend` can name, described by `locality explain <rule>`. */
export const ruleDescriptions: Record<string, Rule> = {
  "single-consumer-tiny": {
    summary: "One consumer, and the unit is tiny: inline it",
    explanation: lines(
      "The unit is used by exactly one production file and is at most locality.tinyLines lines long, so the cost of the",
      "import (an extra file to open) outweighs what the unit says. The default is to inline it into its consumer.",
      "A unit of several files cannot be inlined, so it moves next to the consumer instead.",
      "",
      "Inline is a separate commit made by the agent. Keep the unit when it encodes a domain rule that needs one source",
      "of truth, or when its name explains the code better than the code does.",
    ),
  },
  "single-consumer-medium": {
    summary: "One consumer and a medium unit: inline if the consumer stays readable, otherwise move",
    explanation: lines(
      "The unit is used by one production file and is larger than a tiny unit but no larger than locality.largeLines.",
      "It is inlined when the consumer plus the unit stay within locality.inlineHostLines lines, otherwise it moves",
      "next to the consumer as its own module.",
    ),
  },
  "single-consumer-large": {
    summary: "One consumer and a large unit: move it next to the consumer, as its own module",
    explanation: lines(
      "The unit is longer than locality.largeLines lines and has one production consumer. Inlining would bury the",
      "consumer, so the unit keeps its own file and moves to the target folder, usually the consumer's.",
    ),
  },
  "two-consumers": {
    summary: "Two consumers: move to the target",
    explanation: lines(
      "Two production files use the unit. It moves to the folder that minimises its net distance: the consumers'",
      "lowest common ancestor when the unit has no outside dependencies.",
      "",
      "Two consumers that rarely change together suggest coincidental reuse: see independent-consumers. When the",
      "history gives too little to judge, the default is the move.",
    ),
  },
  "independent-consumers": {
    summary: "Two consumers that rarely change together: coincidental reuse, so review before moving",
    explanation: lines(
      "Two production files use the unit, but their median co-change degree over the window is at or below",
      "locality.lowCoChange percent, with at least locality.minCoChangeChanges logical changes touching them. Independent",
      "consumers suggest the reuse is coincidence: inlining into each may be better than moving to the common folder.",
      "Look at coChange.consumers to see whether the unit itself changes with either.",
    ),
  },
  "consumers-co-change": {
    summary: "Three or more consumers that change together: the distance is earned, keep",
    explanation: lines(
      "At least three production files use the unit and their median co-change degree over the window is at or above",
      "locality.highCoChange percent: they share a reason to change, so the unit's distance from them is earned.",
      "It is kept where it is. Scrutinise it if its fan-in is high.",
    ),
  },
  "within-grace-period": {
    summary: "A unit younger than locality.graceDays is not inlined or moved",
    explanation: lines(
      "One callsite is only evidence once reuse has had time to happen, so a unit whose entry file first appeared fewer",
      "than locality.graceDays days before HEAD is reviewed instead of inlined or moved. Re-run once it has aged.",
    ),
  },
  "creates-cycle": {
    summary: "Moving to the target would create an import cycle between folders",
    explanation: lines(
      "Moving the unit to its target folder would make folders import each other that do not now, and an import cycle",
      "is not made by a move. Cycles between a folder and its own subfolders are not counted. Review the unit's",
      "dependencies, or break the dependency first with the structure plugin, then re-analyse.",
    ),
  },
  "three-or-more-consumers": {
    summary: "Three or more consumers: judge whether they share a reason to change",
    explanation: lines(
      "At the third consumer the rule of three asks for judgement, not a mechanical answer. If the consumers change",
      "together, the distance is earned and the unit is kept. If they change independently, consider moving or",
      "inlining where the consumers diverge. With enough history the median co-change between consumers decides: at or",
      "above locality.highCoChange percent the rule is consumers-co-change (keep). Otherwise, and when history gives",
      "too little to judge, the answer is review.",
    ),
  },
  "high-fan-in": {
    summary: "Fan-in at or above locality.highFanIn: the location is earned, so review the design",
    explanation: lines(
      "Many production files depend on the unit, so every flaw in it is multiplied by its consumers.",
      "The unit is not moved. It goes to the review checklist: shallow module, special-general mixture, overexposure,",
      "pass-through method, vague name, and correctness under every caller.",
    ),
  },
  "pass-through": {
    summary: "A pass-through with one consumer: inline it",
    explanation: lines(
      "Every exported function of the file only calls something else with the arguments it was given, and one",
      "production file uses it. It adds a name and a hop and hides nothing, so the default is to inline it, whatever its",
      "distance.",
    ),
  },
  "single-consumer-barrel": {
    summary: "A barrel with one importing file: inline it by rewriting imports to the real definitions",
    explanation: lines(
      "The file only re-exports other modules and one production file imports it. The importer can import the real",
      "definitions directly and the barrel can go.",
    ),
  },
  "mixed-exports": {
    summary: "Exports with disjoint consumers in different folders: split the file",
    explanation: lines(
      "Two or more groups of exports share no consumers and do not refer to each other, and their consumers live in",
      "different folders: the file is several units sharing a name (coincidental cohesion). Each group becomes its own",
      "file, then is scored and recommended on its own: see cohesion.components in the output.",
      "",
      "A split is its own commit, before any move.",
    ),
  },
  "blocked-by-dependency": {
    summary: "The gain is below the minimum, but would clear it if a dependency were resolved",
    explanation: lines(
      "The unit would gain from moving closer to its consumers, but its own dependencies hold it where it is.",
      "Each blocker lists its unblocked gain. Resolve one by judgement: grow the unit to take it along, accept the",
      "coupling, split the blocker first, break the dependency, or move anyway when the blocker is stable.",
      "Then re-analyse before moving, because resolving a blocker changes the graph.",
    ),
  },
  "near-consumers": {
    summary: "Already close to its consumers: nothing to do",
    explanation: lines(
      "The gain from moving is below locality.minDistance and no blocker would change that.",
      "Units with this rule are not listed.",
    ),
  },
  "other-references": {
    summary: "Guard: a consumer uses the unit as a value, so callsite counts cannot be trusted",
    explanation: lines(
      "At least one production file passes the unit as a value, registers it or decorates with it. Counting callsites",
      "undercounts its use, so an inline or move becomes a review.",
    ),
  },
  "package-entry": {
    summary: "Guard: the unit is exported from a published package entry point",
    explanation: lines(
      "A non-private package manifest (package.json, pyproject.toml, Cargo.toml and the like) names the file as an entry point, so consumers outside the",
      "repository may exist. An inline or move becomes a review.",
    ),
  },
  "scattered-unit": {
    summary: "Guard: the unit's files live outside its entry file's folder, so its leaves are scored on their own",
    explanation: lines(
      "A dominator unit moves as one block with its layout kept, but some of its files sit in folders outside the entry",
      "file's own folder. A single move of that block is coarse advice. The unit's leaves are candidates in their own",
      "right: move or inline them first (leaves before roots), then re-analyse.",
    ),
  },
  "fixed-point": {
    summary: "Guard: the unit is a fixed point (locality.fixedPoints) and stays where it is",
    explanation: lines(
      "A file of the unit matches a glob in locality.fixedPoints: framework conventions such as routes, migrations or",
      "app folders. Fixed points do not move, and code is not moved into folders they cover.",
    ),
  },
  "no-production-consumers": {
    summary: "No production file uses the unit: dead code or a missing entry point",
    explanation: lines(
      "Nothing in production references what the unit defines (an import that is only re-exported, or one used only by",
      "tests). Check whether it is dead, or whether an entry point is missing from the suite config.",
    ),
  },
};
