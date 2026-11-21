import type { Conclusion } from "@code-health/transcripts/difference";
export { differenceOf, type Arm, type Conclusion, type Difference } from "@code-health/transcripts/difference";

/** Effort is several figures. It fell when two or more fell and none rose, and the reverse for rising. */
export function effortConclusion(parts: readonly Conclusion[]): Conclusion | "mixed" {
  if (parts.every((part) => part === "not-measured")) return "not-measured";
  if (parts.some((part) => part === "insufficient-sample" || part === "not-measured")) return "insufficient-sample";
  const lower = parts.filter((part) => part === "lower").length;
  const higher = parts.filter((part) => part === "higher").length;
  if (lower >= 2 && higher === 0) return "lower";
  if (higher >= 2 && lower === 0) return "higher";
  if (lower === 0 && higher === 0) return "no-change";
  return "mixed";
}

export type Claim =
  | "cheaper"
  | "costlier"
  | "spread-without-effort"
  | "no-effect-shown"
  | "unproven";

/**
 * What the data supports saying. Change spread falls by construction when files that change together are
 * co-located, so it shows only that changes now land closer together. Only agent effort shows they got cheaper.
 */
export function claimOf(effort: Conclusion | "mixed", spread: Conclusion): Claim {
  if (effort === "lower") return "cheaper";
  if (effort === "higher") return "costlier";
  if (spread === "lower") return "spread-without-effort";
  if (effort === "no-change") return "no-effect-shown";
  return "unproven";
}
