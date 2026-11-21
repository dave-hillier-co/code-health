import type { FactorBand } from "./scoring.ts";
import type { PlacementBand } from "./placement.ts";

export type Level = "routine" | "attention" | "elevated";

/**
 * The level from impact and placement together, by the spec's table. Rules, not fitted weights, so
 * anyone can see why a change got it.
 *
 * |                 | close     | mixed or unknown | distant  |
 * |-----------------|-----------|------------------|----------|
 * | impact low      | routine   | routine          | attention|
 * | impact moderate | routine   | attention        | elevated |
 * | impact high     | attention | elevated         | elevated |
 *
 * Null when the impact could not be placed. A level never rests on a guess.
 */
export function levelOf(impact: FactorBand, placement: PlacementBand): Level | null {
  if (impact === "unavailable") return null;
  const column = placement === "close" ? 0 : placement === "distant" ? 2 : 1;
  const table: Record<string, [Level, Level, Level]> = {
    low: ["routine", "routine", "attention"],
    moderate: ["routine", "attention", "elevated"],
    high: ["attention", "elevated", "elevated"],
  };
  return table[impact]![column]!;
}

export const LEVELS: readonly Level[] = ["routine", "attention", "elevated"];
