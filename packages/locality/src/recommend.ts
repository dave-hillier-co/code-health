export type Recommendation = "inline" | "move" | "split" | "blocked" | "keep" | "scrutinise" | "review";

export interface RecommendInput {
  /** Distinct production consumer files. */
  fanIn: number;
  /** Net distance saved by moving to the target as things stand. */
  gain: number;
  /** The gain if the best single blocker were resolved. */
  unblockedGain: number;
  lines: number;
  files: number;
  /** Lines of the single consumer, when there is exactly one. */
  consumerLines: number | null;
  /** References that are not calls: callsite counts are unreliable when there are any. */
  otherRefs: number;
  packageEntry: boolean;
  /** Some file of the unit lives outside its entry file's folder, so moving the unit as one block is coarse. */
  scattered: boolean;
  fixedPoint: boolean;
  passThrough: boolean;
  barrelWithOneConsumer: boolean;
  splitCandidate: boolean;
  minDistance: number;
  tinyLines: number;
  largeLines: number;
  inlineHostLines: number;
  highFanIn: number;
}

export interface Decision {
  recommendation: Recommendation;
  /** Names the rule that fired, described by `locality explain <rule>`. */
  rule: string;
}

/**
 * The default recommendation for a unit: the same inputs always give the same answer. Rules for any unit
 * come first, then the rules by consumer count for units far enough from their consumers. Guards turn an
 * inline or a move into a review. They are defaults for the agent to confirm or override.
 */
export function recommend(input: RecommendInput): Decision {
  if (input.fixedPoint) return { recommendation: "keep", rule: "fixed-point" };
  if (input.barrelWithOneConsumer) return guard(input, { recommendation: "inline", rule: "single-consumer-barrel" });
  if (input.splitCandidate) return { recommendation: "split", rule: "mixed-exports" };
  if (input.fanIn >= input.highFanIn) return { recommendation: "scrutinise", rule: "high-fan-in" };
  if (input.fanIn === 0) return { recommendation: "review", rule: "no-production-consumers" };
  if (input.passThrough && input.fanIn === 1) return guard(input, { recommendation: "inline", rule: "pass-through" });

  if (input.gain < input.minDistance) {
    return input.unblockedGain >= input.minDistance
      ? { recommendation: "blocked", rule: "blocked-by-dependency" }
      : { recommendation: "keep", rule: "near-consumers" };
  }
  if (input.fanIn >= 3) return { recommendation: "review", rule: "three-or-more-consumers" };
  if (input.fanIn === 2) return guard(input, { recommendation: "move", rule: "two-consumers" });
  return guard(input, singleConsumer(input));
}

function singleConsumer(input: RecommendInput): Decision {
  const { lines, files } = input;
  if (lines <= input.tinyLines) {
    return { recommendation: files === 1 ? "inline" : "move", rule: "single-consumer-tiny" };
  }
  if (lines > input.largeLines) return { recommendation: "move", rule: "single-consumer-large" };
  const readable = input.consumerLines !== null && input.consumerLines + lines <= input.inlineHostLines;
  return { recommendation: files === 1 && readable ? "inline" : "move", rule: "single-consumer-medium" };
}

function guard(input: RecommendInput, decision: Decision): Decision {
  if (decision.recommendation !== "inline" && decision.recommendation !== "move") return decision;
  if (input.otherRefs > 0) return { recommendation: "review", rule: "other-references" };
  if (input.packageEntry) return { recommendation: "review", rule: "package-entry" };
  if (input.scattered) return { recommendation: "review", rule: "scattered-unit" };
  return decision;
}
