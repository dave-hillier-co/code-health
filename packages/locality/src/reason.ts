import type { Decision, RecommendInput } from "./recommend.ts";
import { ruleDescriptions } from "./rules.ts";

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * One sentence that says, in literal terms, why a unit has the recommendation it has. A recommendation other
 * than `move` has no default move: `locality move` needs --reason for it, so the sentence says that too.
 */
export function reasonFor(input: RecommendInput, decision: Decision): string {
  const needsReason = decision.recommendation === "move" || decision.recommendation === "inline" ? "" : ` \`locality move\` needs --reason for ${decision.recommendation === "review" ? "a review" : `a ${decision.recommendation}`}.`;
  const consumers = plural(input.fanIn, "consumer file");
  switch (decision.rule) {
    case "three-or-more-consumers": {
      const coChange =
        input.consumerCoChange === null
          ? "whether they change together is not known (the history gives fewer than locality.minCoChangeChanges changes touching them, or is not available)"
          : `their median co-change is ${input.consumerCoChange} percent, below the locality.highCoChange guideline of ${input.highCoChange} percent`;
      return `${consumers} use it, so whether it moves is for judgement; ${coChange}.${needsReason}`;
    }
    case "other-references":
      return `${plural(input.otherRefs, "consumer file")} use it as a value, not a call, so callsite counts are not reliable and the move is for judgement.${needsReason}`;
    case "independent-consumers":
      return `${consumers} use it and their median co-change is ${input.consumerCoChange} percent, at or below the locality.lowCoChange guideline of ${input.lowCoChange} percent, which suggests coincidental reuse.${needsReason}`;
    case "within-grace-period":
      return `its entry file first appeared ${input.age} days before HEAD, inside the locality.graceDays guideline of ${input.graceDays} days, so one callsite is not yet evidence of reuse.${needsReason}`;
    case "no-production-consumers":
      return `no production file uses it: it is dead code, or an entry point is missing from the suite config.${needsReason}`;
    case "creates-cycle":
      return `moving it to its target would make folders import each other that do not now.${needsReason}`;
    default: {
      const rule = ruleDescriptions[decision.rule];
      return `${rule === undefined ? decision.rule : rule.summary}.${needsReason}`.replace("..", ".");
    }
  }
}
